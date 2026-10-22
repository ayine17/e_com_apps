import { Controller, Get, NotFoundException, Query } from "@nestjs/common";
import { Public } from "../common/auth";
import { PrismaService } from "../core/prisma.service";

/** Development-only inbox so login codes and notifications can be read without an email provider. */
@Public()
@Controller("dev")
export class DevController {
  constructor(private readonly prisma: PrismaService) {}

  @Get("emails")
  emails(@Query("to") to?: string) {
    if (process.env.NODE_ENV === "production") throw new NotFoundException();
    return this.prisma.emailOutbox.findMany({ where: to ? { to: to.toLowerCase() } : {}, orderBy: { createdAt: "desc" }, take: 50 });
  }
}
