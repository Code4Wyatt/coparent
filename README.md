# Coparent

Backend-first monorepo for a coparenting application. The repository uses pnpm workspaces and Turborepo; each workspace can be built and deployed independently.

## Backend

`apps/backend` contains the AWS CDK application, API Gateway REST API, and Lambda handlers. The initial `/health` route confirms that the API is deployed. Product domains are organized under `apps/backend/src/features` so messaging, calls, and calendar can evolve with clear ownership as they are implemented.

## Requirements

- Node.js 22 or newer
- pnpm 11
- AWS CDK credentials and a bootstrapped AWS environment to deploy

## Commands

From the repository root:

```sh
pnpm install
pnpm build
pnpm check-types
pnpm synth
pnpm deploy
```

`pnpm synth` creates a CloudFormation template without deploying. Set the CDK context `stage` to choose a stack stage, for example `pnpm deploy -- --context stage=dev`.

The AWS account and region are read from the active AWS credentials/configuration. Deploying for the first time in an AWS environment may require `pnpm --filter @coparent/backend bootstrap`.
