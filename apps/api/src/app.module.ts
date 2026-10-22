import { MiddlewareConsumer, Module, NestModule } from "@nestjs/common";
import { APP_FILTER, APP_GUARD } from "@nestjs/core";
import { JwtModule } from "@nestjs/jwt";
import { ScheduleModule } from "@nestjs/schedule";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
import { AccountsController } from "./accounts/accounts.controller";
import { MeController } from "./accounts/me.controller";
import { ReviewsController } from "./aftercare/reviews.controller";
import { ReturnsController } from "./aftercare/returns.controller";
import { ReturnsService } from "./aftercare/returns.service";
import { SellersController } from "./sellers/sellers.controller";
import { PayoutsService } from "./sellers/payouts.service";
import { AdminController } from "./admin/admin.controller";
import { AuthController } from "./auth/auth.controller";
import { CatalogController } from "./catalog/catalog.controller";
import { AuthGuard } from "./common/auth";
import { DomainErrorsFilter } from "./common/errors.filter";
import { OriginCheckMiddleware } from "./common/origin.middleware";
import { loadConfig } from "./config";
import { CoreModule } from "./core/core.module";
import { DevController } from "./dev/dev.controller";
import { DisputeResolver } from "./disputes/dispute-resolver.service";
import { DisputesController } from "./disputes/disputes.controller";
import { EscrowJobs } from "./jobs/escrow-jobs.service";
import { CheckoutService } from "./orders/checkout.service";
import { OrdersController } from "./orders/orders.controller";

const config = loadConfig();
const isProd = config.NODE_ENV === "production";

@Module({
  imports: [
    CoreModule,
    JwtModule.register({ global: true, secret: config.JWT_SECRET }),
    ThrottlerModule.forRoot({ throttlers: [{ name: "default", ttl: 60_000, limit: 120 }], skipIf: () => config.NODE_ENV === "test" }),
    ScheduleModule.forRoot(),
  ],
  controllers: [
    AuthController, AccountsController, MeController, CatalogController, OrdersController, DisputesController, ReviewsController,
    ReturnsController, SellersController, AdminController,
    ...(isProd ? [] : [DevController]),
  ],
  providers: [
    CheckoutService,
    DisputeResolver,
    ReturnsService,
    PayoutsService,
    EscrowJobs,
    // Order matters: rate limit first, then authenticate.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_FILTER, useClass: DomainErrorsFilter },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(OriginCheckMiddleware).forRoutes("*path");
  }
}
