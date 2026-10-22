import {
  CanActivate, createParamDecorator, ExecutionContext, ForbiddenException, Injectable,
  SetMetadata, UnauthorizedException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { JwtService } from "@nestjs/jwt";
import { Role, User } from "@prisma/client";
import { Request } from "express";
import { PrismaService } from "../core/prisma.service";

export const SESSION_COOKIE = "session";

const IS_PUBLIC = "isPublic";
const ROLES = "roles";

/** Marks a route as reachable without logging in. Everything else requires a session. */
export const Public = () => SetMetadata(IS_PUBLIC, true);
export const Roles = (...roles: Role[]) => SetMetadata(ROLES, roles);

export type AuthedRequest = Request & { user?: User };

export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext) => {
  return ctx.switchToHttp().getRequest<AuthedRequest>().user;
});

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [ctx.getHandler(), ctx.getClass()]);

    const token: string | undefined = req.cookies?.[SESSION_COOKIE];
    if (token) {
      try {
        const { sub } = await this.jwt.verifyAsync<{ sub: string }>(token);
        const user = await this.prisma.user.findUnique({ where: { id: sub } });
        if (user && !user.suspendedAt && !user.deletedAt) req.user = user;
      } catch {
        // Invalid or expired token: treat as logged out.
      }
    }

    if (isPublic) return true;
    if (!req.user) throw new UnauthorizedException("Please log in");

    const roles = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES, [ctx.getHandler(), ctx.getClass()]);
    if (roles?.length && !roles.some((r) => req.user!.roles.includes(r))) {
      throw new ForbiddenException("You don't have permission to do that");
    }
    return true;
  }
}

export function isStaff(user: User): boolean {
  return user.roles.includes("ADMIN") || user.roles.includes("AGENT");
}
