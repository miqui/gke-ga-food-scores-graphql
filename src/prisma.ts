import { PrismaClient } from '@prisma/client';

// Single shared client for the process; Prisma pools connections internally.
// Connection string comes from DATABASE_URL (see prisma/schema.prisma).
export const prisma = new PrismaClient();
