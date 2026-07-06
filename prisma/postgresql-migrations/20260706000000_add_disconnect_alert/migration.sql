-- CreateTable
CREATE TABLE "DisconnectAlert" (
    "id" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "alertNumber" VARCHAR(100),
    "senderName" VARCHAR(100),
    "message" VARCHAR(500),
    "createdAt" TIMESTAMP,
    "updatedAt" TIMESTAMP NOT NULL,
    "instanceId" TEXT NOT NULL,

    CONSTRAINT "DisconnectAlert_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DisconnectAlert_instanceId_key" ON "DisconnectAlert"("instanceId");

-- AddForeignKey
ALTER TABLE "DisconnectAlert" ADD CONSTRAINT "DisconnectAlert_instanceId_fkey"
    FOREIGN KEY ("instanceId") REFERENCES "Instance"("id") ON DELETE CASCADE ON UPDATE CASCADE;
