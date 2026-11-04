-- CreateTable
CREATE TABLE "SoloSync" (
    "userId" TEXT NOT NULL,
    "data" TEXT NOT NULL,
    "rev" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SoloSync_pkey" PRIMARY KEY ("userId")
);

-- AddForeignKey
ALTER TABLE "SoloSync" ADD CONSTRAINT "SoloSync_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
