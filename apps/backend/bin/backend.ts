#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { BackendStack } from "../lib/backend-stack";

const app = new cdk.App();
const environment = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION,
};

const sharedServices = new cdk.Stack(app, "CoparentSharedServices", { env: environment });
const mediaPipelinesRole = new cdk.aws_iam.CfnServiceLinkedRole(
  sharedServices,
  "ChimeMediaPipelinesServiceLinkedRole",
  { awsServiceName: "mediapipelines.chime.amazonaws.com" },
);
mediaPipelinesRole.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);

for (const stage of ["dev", "staging", "production"]) {
  const stack = new BackendStack(app, `CoparentBackend-${stage}`, { stage, env: environment });
  stack.addStackDependency(sharedServices, "Account-level Chime media pipeline service role");
  cdk.Tags.of(stack).add("Environment", stage);
}
