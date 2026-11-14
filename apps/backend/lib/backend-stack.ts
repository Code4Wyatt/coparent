import { join } from "node:path";
import {
  CfnOutput,
  Duration,
  RemovalPolicy,
  Stack,
  StackProps,
} from "aws-cdk-lib";
import { Runtime, StartingPosition } from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { DynamoEventSource, SqsDlq, SqsEventSource } from "aws-cdk-lib/aws-lambda-event-sources";
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
import { PolicyStatement, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import { Alarm, ComparisonOperator, TreatMissingData } from "aws-cdk-lib/aws-cloudwatch";
import { BlockPublicAccess, Bucket, BucketEncryption, ObjectOwnership } from "aws-cdk-lib/aws-s3";
import { Queue, QueueEncryption } from "aws-cdk-lib/aws-sqs";
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
      metricsEnabled: true,
      tracingEnabled: true,
      throttlingBurstLimit: 100,
      throttlingRateLimit: 50,
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

    const billingDeadLetterQueue = new Queue(this, "BillingEventsDeadLetterQueue", {
      encryption: QueueEncryption.SQS_MANAGED,
      retentionPeriod: Duration.days(14),
    });
    const billingEventsQueue = new Queue(this, "BillingEventsQueue", {
      encryption: QueueEncryption.SQS_MANAGED,
      retentionPeriod: Duration.days(4),
      visibilityTimeout: Duration.seconds(120),
      deadLetterQueue: { queue: billingDeadLetterQueue, maxReceiveCount: 5 },
    });
    new Alarm(this, "BillingEventsDeadLetterAlarm", {
      metric: billingDeadLetterQueue.metricApproximateNumberOfMessagesVisible({ period: Duration.minutes(5) }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    });
    const billingHandler = new NodejsFunction(this, "BillingEventHandler", {
      entry: join(__dirname, "../src/features/billing/handler.ts"),
      handler: "handler",
      runtime: Runtime.NODEJS_22_X,
      memorySize: 512,
      timeout: Duration.seconds(20),
      bundling: { target: "node22", minify: true, sourceMap: true },
      environment: { DATA_TABLE_NAME: dataTable.tableName },
    });
    dataTable.grantReadWriteData(billingHandler);
    billingHandler.addEventSource(new SqsEventSource(billingEventsQueue, {
      batchSize: 10,
      reportBatchItemFailures: true,
    }));

    const notificationStreamFailureQueue = new Queue(this, "NotificationStreamFailureQueue", {
      encryption: QueueEncryption.SQS_MANAGED,
      retentionPeriod: Duration.days(14),
    });
    const notificationDeliveryDeadLetterQueue = new Queue(this, "NotificationDeliveryDeadLetterQueue", {
      encryption: QueueEncryption.SQS_MANAGED,
      retentionPeriod: Duration.days(14),
    });
    const notificationQueue = new Queue(this, "NotificationDispatchQueue", {
      encryption: QueueEncryption.SQS_MANAGED,
      retentionPeriod: Duration.days(4),
      visibilityTimeout: Duration.seconds(120),
      deadLetterQueue: { queue: notificationDeliveryDeadLetterQueue, maxReceiveCount: 5 },
    });
    new Alarm(this, "NotificationStreamFailureAlarm", {
      metric: notificationStreamFailureQueue.metricApproximateNumberOfMessagesVisible({ period: Duration.minutes(5) }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    });
    new Alarm(this, "NotificationDeliveryFailureAlarm", {
      metric: notificationDeliveryDeadLetterQueue.metricApproximateNumberOfMessagesVisible({ period: Duration.minutes(5) }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    });
    const outboxDispatcher = new NodejsFunction(this, "NotificationOutboxDispatcher", {
      entry: join(__dirname, "../src/features/notifications/outbox-dispatcher.ts"),
      handler: "handler",
      runtime: Runtime.NODEJS_22_X,
      memorySize: 512,
      timeout: Duration.seconds(20),
      bundling: { target: "node22", minify: true, sourceMap: true },
      environment: {
        DATA_TABLE_NAME: dataTable.tableName,
        NOTIFICATION_QUEUE_URL: notificationQueue.queueUrl,
      },
    });
    dataTable.grantReadWriteData(outboxDispatcher);
    notificationQueue.grantSendMessages(outboxDispatcher);
    outboxDispatcher.addEventSource(new DynamoEventSource(dataTable, {
      startingPosition: StartingPosition.TRIM_HORIZON,
      batchSize: 50,
      bisectBatchOnError: true,
      retryAttempts: 3,
      reportBatchItemFailures: true,
      onFailure: new SqsDlq(notificationStreamFailureQueue),
      filters: [{
        eventName: ["INSERT"],
        dynamodb: { NewImage: { entityType: { S: ["NOTIFICATION_OUTBOX"] } } },
      }],
    }));

    new CfnOutput(this, "ApiUrl", {
      value: api.url,
      description: "Base URL for the Coparent REST API",
    });

    new CfnOutput(this, "UserPoolId", { value: userPool.userPoolId });
    new CfnOutput(this, "UserPoolClientId", { value: userPoolClient.userPoolClientId });
    new CfnOutput(this, "DataTableName", { value: dataTable.tableName });
    new CfnOutput(this, "BillingEventsQueueUrl", { value: billingEventsQueue.queueUrl });
    new CfnOutput(this, "NotificationDispatchQueueUrl", { value: notificationQueue.queueUrl });
  }
}
