# Azure Resources & Users Dashboard — Design Spec

## Overview

Sub-project 2 of the multi-cloud rollout (see `docs/superpowers/specs/2026-08-24-multi-cloud-credentials-and-resources-design.md`, "Foundation," already shipped). Foundation lets a company save one or more Azure connections (Tenant ID / Client ID / Client Secret / Subscription ID) in Settings, but there is nowhere to view what's actually running in that Azure subscription. This spec adds that: an "Azure" tab with the same Overview / Resources / Users three-way sub-tab structure the AWS tab already has, reusing every piece of shared UI built for AWS (`ResourceGrid`, `ResourceLegend`, the age-color-coding, the per-row "Verify" mailto icon, the multi-account picker pattern) with Azure-specific data underneath.

This mirrors the AWS Resources/IAM Users feature almost exactly in shape — same account-picker pattern (Task 9/10's design), same shared grid component, same age-coloring and verify-icon behavior — the new work is entirely in the Azure SDK integration: what to call, what fields to show, and how Azure's Entra ID (Azure AD) permission model differs from AWS IAM's.

## Goals

- New `app/api/azure/resources/route.ts`: `GET ?companyId=&credentialId=`, decrypts the Azure connection's `{tenantId, clientId, clientSecret, subscriptionId}`, builds one shared `ClientSecretCredential`, and fetches 7 resource types in parallel (mirroring AWS's `Promise.all` over never-rejecting per-service fetchers): Virtual Machines, Azure Functions, Container Instances, Azure SQL Databases, Cosmos DB accounts, API Management services, Storage Accounts.
- New `app/api/azure/ad-users/route.ts`: `GET ?companyId=&credentialId=`, lists Entra ID (Azure AD) users via Microsoft Graph, using the same stored app-registration credentials (requires the app registration to also have Graph `User.Read.All` application permission granted with admin consent — a separate grant from the ARM "Reader" role used for the resources above; this route's error message must say so plainly when it fails with an authorization error, since "my Azure key works for Resources but not Users" is the single most likely support question this feature will generate).
- New `components/reports/AzureResourcesTab.tsx` and `components/reports/AzureUsersTab.tsx`, structurally identical to `AwsResourcesTab.tsx`/`AwsIamUsersTab.tsx` (account picker sourced from `GET /api/settings/azure-credentials`, `ResourceGrid`/`ResourceLegend` reuse, Refresh button, per-connection "not connected" messaging).
- Extend `AppShell.tsx`'s existing Azure tab (currently a bare `CostReportTab`) with the same Overview/Resources/Users sub-tab strip the AWS tab has, reusing the exact `isAwsWideView`-style layout-widening logic (renamed to something provider-agnostic, e.g. `isWideCloudView`, since it now applies to both AWS's and Azure's non-Overview sub-tabs).

## Non-goals

- GCP and Snowflake dashboards remain separate future sub-projects (3 and 4), untouched here.
- No changes to the AWS-side code beyond the rename noted above (`isAwsWideView` → a name that also covers Azure) and, if needed, generalizing any AWS-specific naming in shared layout CSS classes.
- No v2 cross-account-role support — this sub-project uses the existing `auth_type: 'keys'` Azure connections from Foundation exactly as they are.
- Azure SQL Database listing accepts a per-server N+1 call pattern (list servers, then list databases per server) as the cost of Azure's data model not offering a flat cross-subscription "all databases" list without a separate Resource Graph query/package — consistent with this project's precedent (DynamoDB's per-table `DescribeTableCommand` N+1, accepted for the same reason).

## Field/resource mapping (confirmed in the Foundation spec, restated here for this sub-project's direct reference)

| AWS concept | Azure equivalent | SDK package |
|---|---|---|
| EC2 | Virtual Machines | `@azure/arm-compute` |
| Lambda | Azure Functions (Web Apps with `kind` containing `functionapp`) | `@azure/arm-appservice` |
| ECS | Container Instances | `@azure/arm-containerinstance` |
| RDS | Azure SQL Database (servers → databases) | `@azure/arm-sql` |
| DynamoDB | Cosmos DB accounts | `@azure/arm-cosmosdb` |
| APIs | API Management services | `@azure/arm-apimanagement` |
| S3 | Storage Accounts | `@azure/arm-storage` |
| IAM Users | Entra ID (Azure AD) users | `@microsoft/microsoft-graph-client` (+ `@azure/identity` for the token credential adapter) |

Auth for every ARM call: `new ClientSecretCredential(tenantId, clientId, clientSecret)` from `@azure/identity`, passed to each management client alongside `subscriptionId`. Auth for Graph: the same `ClientSecretCredential` wrapped in `@azure/identity`'s `TokenCredentialAuthenticationProvider` (from `@microsoft/microsoft-graph-client/authProviders/azureTokenCredentials`), used to construct the Graph `Client`.

## Verification plan

- Same automated bar as Foundation: component tests (mocked `fetch`) for both new tabs covering connected/not-connected/per-resource-error/empty states, age-coloring, verify-icon, and the account picker; no Jest coverage for the two new API routes (established convention); `npm test`/`tsc`/`lint`/`build` clean.
- **Live verification against a real Azure account**: the user is providing a real test app registration (Tenant ID / Client ID / Client Secret / Subscription ID) with Reader access on at least one subscription and Graph `User.Read.All` granted. Verification follows the same rhythm as AWS: disposable staff test account, save the real Azure connection via Settings, confirm the Resources tab populates with real data (or a clear per-resource error if the Reader role doesn't cover something), confirm the Users tab lists real Entra ID users (or shows the specific "needs Graph permission" message if that grant is missing), clean up afterward. Unlike the AWS key, this credential is a Client Secret tied to an App Registration — remind the user to rotate/regenerate the client secret (not delete the whole app registration, unless they created it solely for this test) after verification.
