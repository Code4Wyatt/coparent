import { join } from "node:path";
import {
  CfnOutput,
  Duration,
  RemovalPolicy,
  Stack,
  StackProps,
} from "aws-cdk-lib";
import { Runtime } from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import {
  CognitoUserPoolsAuthorizer,
  AccessLogFormat,
  AuthorizationType,
  LambdaIntegration,
  LogGroupLogDestination,
  RestApi,
} from "aws-cdk-lib/aws-apigateway";
import { AttributeType, BillingMode, ProjectionType, StreamViewType, Table } from "aws-cdk-lib/aws-dynamodb";
import { UserPool, UserPoolClient, VerificationEmailStyle } from "aws-cdk-lib/aws-cognito";
import { CfnServiceLinkedRole, PolicyStatement, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import { BlockPublicAccess, Bucket, BucketEncryption, ObjectOwnership } from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";

interface BackendStackProps extends StackProps {
  stage: string;
}

export class BackendStack extends Stack {
  constructor(scope: Construct, id: string, props: BackendStackProps) {
    super(scope, id, props);

    const userPool = new UserPool(this, "UserPool", {
      userPoolName: `coparent-users-${props.stage}`,
      selfSignUpEnabled: true,
      signInAliases: { email: true },
      signInCaseSensitive: false,
      autoVerify: { email: true },
      userVerification: {
        emailSubject: "Verify your Coparent account",
        emailBody: "Enter this verification code in Coparent: {####}",
        emailStyle: VerificationEmailStyle.CODE,
      },
      passwordPolicy: {
        minLength: 12,
        requireDigits: true,
        requireLowercase: true,
        requireUppercase: true,
        requireSymbols: true,
      },
    });

    const userPoolClient = new UserPoolClient(this, "UserPoolClient", {
      userPool,
      userPoolClientName: `coparent-client-${props.stage}`,
      authFlows: { userSrp: true },
      disableOAuth: true,
      enableTokenRevocation: true,
      preventUserExistenceErrors: true,
    });

    const dataTable = new Table(this, "AppData", {
      partitionKey: { name: "PK", type: AttributeType.STRING },
      sortKey: { name: "SK", type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: "expiresAt",
      stream: StreamViewType.NEW_AND_OLD_IMAGES,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: RemovalPolicy.RETAIN,
    });

    dataTable.addGlobalSecondaryIndex({
      indexName: "GSI1",
      partitionKey: { name: "GSI1PK", type: AttributeType.STRING },
      sortKey: { name: "GSI1SK", type: AttributeType.STRING },
      projectionType: ProjectionType.ALL,
    });
    dataTable.addGlobalSecondaryIndex({
      indexName: "GSI2",
      partitionKey: { name: "GSI2PK", type: AttributeType.STRING },
      sortKey: { name: "GSI2SK", type: AttributeType.STRING },
      projectionType: ProjectionType.ALL,
    });

    const apiAccessLogs = new LogGroup(this, "ApiAccessLogs", {
      retention: RetentionDays.ONE_MONTH,
    });

    const stageOptions = {
      stageName: props.stage,
      accessLogDestination: new LogGroupLogDestination(apiAccessLogs),
      accessLogFormat: AccessLogFormat.jsonWithStandardFields(),
    };

    const api = new RestApi(this, "CoparentRestApi", {
      restApiName: `coparent-api-${props.stage}`,
      deployOptions: stageOptions,
      cloudWatchRole: true,
      defaultCorsPreflightOptions: {
        allowOrigins: ["*"],
        allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        allowHeaders: ["Authorization", "Content-Type", "X-Amz-Date", "X-Api-Key", "X-Amz-Security-Token"],
      },
    });

    const authorizer = new CognitoUserPoolsAuthorizer(this, "ApiAuthorizer", {
      cognitoUserPools: [userPool],
      authorizerName: `coparent-authorizer-${props.stage}`,
    });

    const healthHandler = new NodejsFunction(this, "HealthHandler", {
      entry: join(__dirname, "../src/functions/health.ts"),
      handler: "handler",
      runtime: Runtime.NODEJS_22_X,
      memorySize: 256,
      timeout: Duration.seconds(5),
      bundling: {
        target: "node22",
        minify: true,
        sourceMap: true,
      },
    });

    api.root.addResource("health").addMethod("GET", new LambdaIntegration(healthHandler));

    const identityHandler = new NodejsFunction(this, "IdentityHandler", {
      entry: join(__dirname, "../src/functions/me.ts"),
      handler: "handler",
      runtime: Runtime.NODEJS_22_X,
      memorySize: 256,
      timeout: Duration.seconds(5),
      bundling: { target: "node22", minify: true, sourceMap: true },
    });

    api.root.addResource("me").addMethod("GET", new LambdaIntegration(identityHandler), {
      authorizer,
      authorizationType: AuthorizationType.COGNITO,
    });

    const familyHandler = new NodejsFunction(this, "FamilyHandler", {
      entry: join(__dirname, "../src/features/families/handler.ts"),
      handler: "handler",
      runtime: Runtime.NODEJS_22_X,
      memorySize: 512,
      timeout: Duration.seconds(10),
      bundling: { target: "node22", minify: true, sourceMap: true },
      environment: { DATA_TABLE_NAME: dataTable.tableName },
    });
    dataTable.grantReadWriteData(familyHandler);

    const familyAuthorizer = { authorizer, authorizationType: AuthorizationType.COGNITO };
    const families = api.root.addResource("families");
    const familyIntegration = new LambdaIntegration(familyHandler);
    families.addMethod("POST", familyIntegration, familyAuthorizer);
    families.addMethod("GET", familyIntegration, familyAuthorizer);

    const familyId = families.addResource("{familyId}");
    const invitations = familyId.addResource("invitations");
    invitations.addMethod("POST", familyIntegration, familyAuthorizer);
    invitations.addMethod("GET", familyIntegration, familyAuthorizer);
    invitations.addResource("{invitationId}").addMethod("DELETE", familyIntegration, familyAuthorizer);
    api.root.addResource("invitations").addResource("accept").addMethod(
      "POST",
      familyIntegration,
      familyAuthorizer,
    );

    const messageHandler = new NodejsFunction(this, "MessageHandler", {
      entry: join(__dirname, "../src/features/messages/handler.ts"),
      handler: "handler",
      runtime: Runtime.NODEJS_22_X,
      memorySize: 512,
      timeout: Duration.seconds(10),
      bundling: { target: "node22", minify: true, sourceMap: true },
      environment: {
        DATA_TABLE_NAME: dataTable.tableName,
        MODERATION_BLOCK_THRESHOLD: "0.85",
        MODERATION_POLICY_VERSION: "v1",
      },
    });
    dataTable.grantReadWriteData(messageHandler);
    messageHandler.addToRolePolicy(new PolicyStatement({
      actions: ["comprehend:DetectToxicContent"],
      resources: ["*"],
    }));

    const messageIntegration = new LambdaIntegration(messageHandler);
    const messages = familyId.addResource("messages");
    messages.addMethod("POST", messageIntegration, familyAuthorizer);
    messages.addMethod("GET", messageIntegration, familyAuthorizer);
    const message = messages.addResource("{messageId}");
    message.addResource("read").addMethod("POST", messageIntegration, familyAuthorizer);
    message.addResource("reports").addMethod("POST", messageIntegration, familyAuthorizer);

    const calendarHandler = new NodejsFunction(this, "CalendarHandler", {
      entry: join(__dirname, "../src/features/calendar/handler.ts"),
      handler: "handler",
      runtime: Runtime.NODEJS_22_X,
      memorySize: 512,
      timeout: Duration.seconds(10),
      bundling: { target: "node22", minify: true, sourceMap: true },
      environment: { DATA_TABLE_NAME: dataTable.tableName },
    });
    dataTable.grantReadWriteData(calendarHandler);

    const calendarIntegration = new LambdaIntegration(calendarHandler);
    const calendar = familyId.addResource("calendar");
    calendar.addMethod("GET", calendarIntegration, familyAuthorizer);
    const events = calendar.addResource("events");
    events.addMethod("POST", calendarIntegration, familyAuthorizer);
    events.addResource("{eventId}").addResource("history").addMethod("GET", calendarIntegration, familyAuthorizer);
    const proposals = calendar.addResource("proposals");
    proposals.addMethod("POST", calendarIntegration, familyAuthorizer);
    const proposal = proposals.addResource("{proposalId}");
    proposal.addMethod("DELETE", calendarIntegration, familyAuthorizer);
    proposal.addResource("respond").addMethod(
      "POST",
      calendarIntegration,
      familyAuthorizer,
    );

    const recordingsBucket = new Bucket(this, "CallRecordings", {
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      encryption: BucketEncryption.S3_MANAGED,
      objectOwnership: ObjectOwnership.BUCKET_OWNER_PREFERRED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    recordingsBucket.addToResourcePolicy(new PolicyStatement({
      actions: ["s3:PutObject", "s3:PutObjectAcl", "s3:GetObject", "s3:ListBucket"],
      principals: [new ServicePrincipal("mediapipelines.chime.amazonaws.com")],
      resources: [recordingsBucket.bucketArn, recordingsBucket.arnForObjects("*")],
      conditions: {
        StringEquals: { "aws:SourceAccount": this.account },
        ArnLike: { "aws:SourceArn": `arn:${this.partition}:chime:*:${this.account}:*` },
      },
    }));
    new CfnServiceLinkedRole(this, "ChimeMediaPipelinesServiceLinkedRole", {
      awsServiceName: "mediapipelines.chime.amazonaws.com",
    });

    const callHandler = new NodejsFunction(this, "CallHandler", {
      entry: join(__dirname, "../src/features/calls/handler.ts"),
      handler: "handler",
      runtime: Runtime.NODEJS_22_X,
      memorySize: 512,
      timeout: Duration.seconds(20),
      bundling: { target: "node22", minify: true, sourceMap: true },
      environment: {
        DATA_TABLE_NAME: dataTable.tableName,
        RECORDINGS_BUCKET_NAME: recordingsBucket.bucketName,
        CHIME_MEDIA_REGION: this.region,
      },
    });
    dataTable.grantReadWriteData(callHandler);
    recordingsBucket.grantRead(callHandler);
    callHandler.addToRolePolicy(new PolicyStatement({
      actions: [
        "chime:CreateMeeting", "chime:CreateAttendee", "chime:GetAttendee", "chime:DeleteMeeting",
        "chime:CreateMediaCapturePipeline", "chime:DeleteMediaCapturePipeline",
        "chime:CreateMediaConcatenationPipeline", "chime:GetMediaPipeline",
      ],
      resources: ["*"],
    }));
    callHandler.addToRolePolicy(new PolicyStatement({
      actions: ["s3:GetBucketPolicy"],
      resources: [recordingsBucket.bucketArn],
    }));

    const callIntegration = new LambdaIntegration(callHandler);
    const calls = familyId.addResource("calls");
    calls.addMethod("POST", callIntegration, familyAuthorizer);
    calls.addMethod("GET", callIntegration, familyAuthorizer);
    const call = calls.addResource("{callId}");
    call.addResource("cancel").addMethod("POST", callIntegration, familyAuthorizer);
    call.addResource("respond").addMethod("POST", callIntegration, familyAuthorizer);
    call.addResource("session").addMethod("GET", callIntegration, familyAuthorizer);
    call.addResource("end").addMethod("POST", callIntegration, familyAuthorizer);
    call.addResource("recording").addMethod("GET", callIntegration, familyAuthorizer);

    new CfnOutput(this, "ApiUrl", {
      value: api.url,
      description: "Base URL for the Coparent REST API",
    });

    new CfnOutput(this, "UserPoolId", { value: userPool.userPoolId });
    new CfnOutput(this, "UserPoolClientId", { value: userPoolClient.userPoolClientId });
    new CfnOutput(this, "DataTableName", { value: dataTable.tableName });
  }
}
