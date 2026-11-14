import { join } from "node:path";
import {
  CfnOutput,
  Duration,
  Stack,
  StackProps,
} from "aws-cdk-lib";
import { Runtime } from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import {
  AccessLogFormat,
  LambdaIntegration,
  LogGroupLogDestination,
  RestApi,
} from "aws-cdk-lib/aws-apigateway";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import { Construct } from "constructs";

interface BackendStackProps extends StackProps {
  stage: string;
}

export class BackendStack extends Stack {
  constructor(scope: Construct, id: string, props: BackendStackProps) {
    super(scope, id, props);

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

    new CfnOutput(this, "ApiUrl", {
      value: api.url,
      description: "Base URL for the Coparent REST API",
    });
  }
}
