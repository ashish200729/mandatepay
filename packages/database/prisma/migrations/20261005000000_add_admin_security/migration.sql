CREATE TYPE "AdminRole" AS ENUM ('ADMIN_SUPER');

CREATE TABLE "AdminPrincipal" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "singletonKey" VARCHAR(4) NOT NULL DEFAULT 'main',
  "role" "AdminRole" NOT NULL DEFAULT 'ADMIN_SUPER',
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AdminPrincipal_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AdminPrincipal_singleton_check" CHECK ("singletonKey" = 'main'),
  CONSTRAINT "AdminPrincipal_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "AdminPrincipal_userId_key" ON "AdminPrincipal"("userId");
CREATE UNIQUE INDEX "AdminPrincipal_singletonKey_key" ON "AdminPrincipal"("singletonKey");

CREATE TABLE "AdminSessionSecurity" (
  "sessionId" TEXT NOT NULL,
  "principalId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeenAt" TIMESTAMP(3) NOT NULL,
  "reauthenticatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AdminSessionSecurity_pkey" PRIMARY KEY ("sessionId"),
  CONSTRAINT "AdminSessionSecurity_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "AdminSessionSecurity_principalId_fkey" FOREIGN KEY ("principalId") REFERENCES "AdminPrincipal"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "AdminSessionSecurity_principalId_idx" ON "AdminSessionSecurity"("principalId");
