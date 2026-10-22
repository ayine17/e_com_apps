import { execSync } from "child_process";

export default function globalSetup() {
  execSync("npx prisma migrate deploy", {
    env: { ...process.env, DATABASE_URL: "postgresql://postgres@localhost:5433/marketplace_test" },
    stdio: "ignore",
  });
}
