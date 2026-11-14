import { createHash } from "node:crypto";
import {
  ChimeSDKMeetingsClient,
  CreateAttendeeCommand,
  CreateMeetingCommand,
  DeleteMeetingCommand,
  GetAttendeeCommand,
} from "@aws-sdk/client-chime-sdk-meetings";
import {
  ChimeSDKMediaPipelinesClient,
  CreateMediaCapturePipelineCommand,
  CreateMediaConcatenationPipelineCommand,
  DeleteMediaCapturePipelineCommand,
  GetMediaPipelineCommand,
} from "@aws-sdk/client-chime-sdk-media-pipelines";
import {
  GetObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export interface MediaProvider {
  createMeeting(callId: string, callerId: string, mediaRegion: string): Promise<{ meetingId: string; meetingArn: string }>;
  createAttendee(meetingId: string, externalUserId: string): Promise<string>;
  getJoinToken(meetingId: string, attendeeId: string): Promise<string>;
  startCapture(meetingArn: string, callId: string, bucketName: string): Promise<{ pipelineId: string; pipelineArn: string }>;
  endMeeting(meetingId: string): Promise<void>;
  stopCaptureAndConcatenate(
    capturePipelineId: string,
    capturePipelineArn: string,
    familyId: string,
    callId: string,
    bucketName: string,
  ): Promise<string | undefined>;
  getConcatenationStatus(pipelineId: string): Promise<string | undefined>;
  getRecordingUrl(bucketName: string, prefix: string): Promise<string | undefined>;
}

export class ChimeMediaProvider implements MediaProvider {
  private readonly meetings = new ChimeSDKMeetingsClient({
    region: process.env.CHIME_CONTROL_REGION ?? process.env.AWS_REGION,
  });
  private readonly pipelines = new ChimeSDKMediaPipelinesClient({
    region: process.env.CHIME_CONTROL_REGION ?? process.env.AWS_REGION,
  });
  private readonly s3 = new S3Client({ region: process.env.AWS_REGION });

  async createMeeting(callId: string, callerId: string, mediaRegion: string) {
    const result = await this.meetings.send(new CreateMeetingCommand({
      ClientRequestToken: callId,
      ExternalMeetingId: callId,
      MediaRegion: mediaRegion,
      MeetingHostId: callerId,
    }));
    if (!result.Meeting?.MeetingId || !result.Meeting.MeetingArn) throw new Error("Meeting response omitted its identity");
    return { meetingId: result.Meeting.MeetingId, meetingArn: result.Meeting.MeetingArn };
  }

  async createAttendee(meetingId: string, externalUserId: string) {
    const result = await this.meetings.send(new CreateAttendeeCommand({ MeetingId: meetingId, ExternalUserId: externalUserId }));
    if (!result.Attendee?.AttendeeId) throw new Error("Attendee response omitted its identity");
    return result.Attendee.AttendeeId;
  }

  async getJoinToken(meetingId: string, attendeeId: string) {
    const result = await this.meetings.send(new GetAttendeeCommand({ MeetingId: meetingId, AttendeeId: attendeeId }));
    if (!result.Attendee?.JoinToken) throw new Error("Attendee response omitted its join token");
    return result.Attendee.JoinToken;
  }

  async startCapture(meetingArn: string, callId: string, bucketName: string) {
    const result = await this.pipelines.send(new CreateMediaCapturePipelineCommand({
      ClientRequestToken: this.opaqueId(`capture:${callId}`),
      SourceType: "ChimeSdkMeeting",
      SourceArn: meetingArn,
      SinkType: "S3Bucket",
      SinkArn: `arn:aws:s3:::${bucketName}`,
      ChimeSdkMeetingConfiguration: {
        ArtifactsConfiguration: {
          Audio: { MuxType: "AudioOnly" },
          Video: { State: "Enabled", MuxType: "VideoOnly" },
          Content: { State: "Disabled" },
        },
      },
    }));
    if (!result.MediaCapturePipeline?.MediaPipelineId || !result.MediaCapturePipeline.MediaPipelineArn) {
      throw new Error("Capture response omitted pipeline identity");
    }
    return {
      pipelineId: result.MediaCapturePipeline.MediaPipelineId,
      pipelineArn: result.MediaCapturePipeline.MediaPipelineArn,
    };
  }

  async endMeeting(meetingId: string) {
    try {
      await this.meetings.send(new DeleteMeetingCommand({ MeetingId: meetingId }));
    } catch (error) {
      if (!(error instanceof Error) || error.name !== "NotFoundException") throw error;
    }
  }

  async stopCaptureAndConcatenate(
    capturePipelineId: string,
    capturePipelineArn: string,
    familyId: string,
    callId: string,
    bucketName: string,
  ) {
    try {
      await this.pipelines.send(new DeleteMediaCapturePipelineCommand({ MediaPipelineId: capturePipelineId }));
    } catch (error) {
      if (!(error instanceof Error) || error.name !== "NotFoundException") throw error;
    }
    const result = await this.pipelines.send(new CreateMediaConcatenationPipelineCommand({
      ClientRequestToken: this.opaqueId(`concat:${callId}`),
      Sources: [{
        Type: "MediaCapturePipeline",
        MediaCapturePipelineSourceConfiguration: {
          MediaPipelineArn: capturePipelineArn,
          ChimeSdkMeetingConfiguration: {
            ArtifactsConfiguration: {
              Audio: { State: "Enabled" },
              Video: { State: "Enabled" },
              Content: { State: "Disabled" },
              DataChannel: { State: "Disabled" },
              TranscriptionMessages: { State: "Disabled" },
              MeetingEvents: { State: "Disabled" },
              CompositedVideo: { State: "Disabled" },
            },
          },
        },
      }],
      Sinks: [{
        Type: "S3Bucket",
        S3BucketSinkConfiguration: {
          Destination: `arn:aws:s3:::${bucketName}/${familyId}/${callId}/recording`,
        },
      }],
    }));
    return result.MediaConcatenationPipeline?.MediaPipelineId;
  }

  async getConcatenationStatus(pipelineId: string) {
    const result = await this.pipelines.send(new GetMediaPipelineCommand({ MediaPipelineId: pipelineId }));
    return result.MediaPipeline?.MediaConcatenationPipeline?.Status;
  }

  async getRecordingUrl(bucketName: string, prefix: string) {
    const result = await this.s3.send(new ListObjectsV2Command({ Bucket: bucketName, Prefix: prefix }));
    const recording = result.Contents?.find((object) => object.Key?.endsWith(".mp4"));
    if (!recording?.Key) return undefined;
    return getSignedUrl(this.s3, new GetObjectCommand({ Bucket: bucketName, Key: recording.Key }), { expiresIn: 300 });
  }

  private opaqueId(value: string) {
    return createHash("sha256").update(value).digest("hex");
  }
}
