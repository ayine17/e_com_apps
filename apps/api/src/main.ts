import "reflect-metadata";
try {
  process.loadEnvFile();
} catch {
  // No .env file: rely on the real environment.
}
import { NestFactory } from "@nestjs/core";
import { NestExpressApplication } from "@nestjs/platform-express";
import { configureApp } from "./setup";
import { AppModule } from "./app.module";
import { loadConfig } from "./config";

async function bootstrap() {
  const config = loadConfig();
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true });
  configureApp(app);
  await app.listen(config.PORT);
  console.log(`API listening on http://localhost:${config.PORT}/api`);
}
bootstrap();
