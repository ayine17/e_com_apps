process.env.NODE_ENV = "test";
process.env.DATABASE_URL = "postgresql://postgres@localhost:5433/marketplace_test";
process.env.JWT_SECRET = "test-secret-that-is-at-least-32-characters-long";
process.env.CARRIER_WEBHOOK_SECRET = "test-carrier-webhook-secret";
process.env.WEB_ORIGIN = "http://localhost:3000";
process.env.UPLOAD_DIR = "/tmp/market-test-uploads";
