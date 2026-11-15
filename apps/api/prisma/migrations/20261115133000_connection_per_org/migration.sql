-- DropIndex
DROP INDEX "IntegrationConnection_userId_provider_authIdHash_key";

-- CreateIndex
CREATE UNIQUE INDEX "IntegrationConnection_orgId_userId_provider_authIdHash_key" ON "IntegrationConnection"("orgId", "userId", "provider", "authIdHash");

