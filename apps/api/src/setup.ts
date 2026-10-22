import { NestExpressApplication } from "@nestjs/platform-express";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import { resolve } from "path";
import { loadConfig } from "./config";

/** Shared by main.ts and the tests so both run with the same security settings. */
export function configureApp(app: NestExpressApplication) {
  const config = loadConfig();
  app.setGlobalPrefix("api");
  app.use(helmet({ crossOriginResourcePolicy: { policy: "same-site" } }));
  app.use(cookieParser());
  app.useBodyParser("json", { limit: "200kb" });
  // Local image storage for development. In production, store uploads in S3-compatible storage behind a CDN.
  app.useStaticAssets(resolve(config.UPLOAD_DIR), {
    prefix: "/uploads/",
    index: false,
    dotfiles: "deny",
    setHeaders: (res) => res.setHeader("X-Content-Type-Options", "nosniff"),
  });
  // Behind a load balancer, trust its X-Forwarded-For so rate limits apply per real client.
  if (config.NODE_ENV === "production") app.set("trust proxy", 1);
  app.enableShutdownHooks();
}
