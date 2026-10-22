import { ForbiddenException, Injectable, NestMiddleware } from "@nestjs/common";
import { NextFunction, Request, Response } from "express";
import { loadConfig } from "../config";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * CSRF defence in addition to SameSite cookies: browsers always send Origin on cross-site
 * state-changing requests, so reject any that don't come from the web app.
 */
@Injectable()
export class OriginCheckMiddleware implements NestMiddleware {
  private readonly allowed = new URL(loadConfig().WEB_ORIGIN).origin;

  use(req: Request, _res: Response, next: NextFunction) {
    const origin = req.headers.origin;
    if (!SAFE_METHODS.has(req.method) && origin && origin !== this.allowed) {
      throw new ForbiddenException("Cross-site request blocked");
    }
    next();
  }
}
