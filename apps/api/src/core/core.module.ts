import { Global, Module } from "@nestjs/common";
import { CONFIG, loadConfig } from "../config";
import { AuditService } from "./audit.service";
import { LedgerService } from "./ledger.service";
import { MailService } from "./mail.service";
import { OrderLifecycleService } from "./order-lifecycle.service";
import { FakePaymentProvider, PaymentProvider } from "./payments";
import { PrismaService } from "./prisma.service";
import { RiskService } from "./risk.service";
import { NotificationsService } from "./notifications.service";
import { SettingsService } from "./settings.service";
import { LoginCodesService } from "./login-codes.service";

const providers = [
  PrismaService,
  MailService,
  AuditService,
  LedgerService,
  RiskService,
  SettingsService,
  NotificationsService,
  LoginCodesService,
  OrderLifecycleService,
  { provide: CONFIG, useFactory: loadConfig },
  // Replace with a StripePaymentProvider once test keys are configured.
  { provide: PaymentProvider, useClass: FakePaymentProvider },
];

@Global()
@Module({ providers, exports: providers })
export class CoreModule {}
