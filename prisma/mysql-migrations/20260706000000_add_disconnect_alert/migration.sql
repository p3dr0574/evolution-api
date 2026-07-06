-- CreateTable
CREATE TABLE `DisconnectAlert` (
    `id` VARCHAR(191) NOT NULL,
    `enabled` BOOLEAN NOT NULL DEFAULT false,
    `alertNumber` VARCHAR(100) NULL,
    `senderName` VARCHAR(100) NULL,
    `message` VARCHAR(500) NULL,
    `createdAt` TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
    `updatedAt` TIMESTAMP NOT NULL,
    `instanceId` VARCHAR(191) NOT NULL,

    UNIQUE INDEX `DisconnectAlert_instanceId_key`(`instanceId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `DisconnectAlert` ADD CONSTRAINT `DisconnectAlert_instanceId_fkey`
    FOREIGN KEY (`instanceId`) REFERENCES `Instance`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
