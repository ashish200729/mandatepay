-- Additive only: agent access tokens for the MCP agent gateway and their audit event types.
ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'AGENT_TOKEN_CREATED';
ALTER TYPE "AuditEventType" ADD VALUE IF NOT EXISTS 'AGENT_TOKEN_REVOKED';

-- CreateEnum
CREATE TYPE "AgentTokenScope" AS ENUM ('READ', 'PROPOSE', 'AUTOPAY');

-- CreateTable
CREATE TABLE "AgentAccessToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" VARCHAR(64) NOT NULL,
    "tokenPrefix" VARCHAR(24) NOT NULL,
    "tokenHash" VARCHAR(64) NOT NULL,
    "scopes" "AgentTokenScope"[],
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "lastUsedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentAccessToken_pkey" PRIMARY KEY ("id"),
    -- Only a lowercase hex HMAC-SHA256 digest is ever stored, never the token itself.
    CONSTRAINT "AgentAccessToken_tokenHash_check" CHECK ("tokenHash" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "AgentAccessToken_scopes_check" CHECK (cardinality("scopes") >= 1),
    -- Tokens always expire, at most 90 days after creation.
    CONSTRAINT "AgentAccessToken_expiry_check" CHECK (
      "expiresAt" > "createdAt" AND "expiresAt" <= "createdAt" + INTERVAL '90 days 1 minute'
    )
);

-- CreateIndex
CREATE UNIQUE INDEX "AgentAccessToken_tokenHash_key" ON "AgentAccessToken"("tokenHash");

-- CreateIndex
CREATE INDEX "AgentAccessToken_userId_createdAt_idx" ON "AgentAccessToken"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "AgentAccessToken" ADD CONSTRAINT "AgentAccessToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
