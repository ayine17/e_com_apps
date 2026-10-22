import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService, Tx } from "./prisma.service";

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  record(actorId: string, action: string, subjectId: string | null, details: Prisma.InputJsonValue = {}, tx: Tx = this.prisma) {
    return tx.auditLog.create({ data: { actorId, action, subjectId, details } });
  }
}
