import { ArgumentsHost, Catch, ConflictException, ExceptionFilter } from "@nestjs/common";
import { BaseExceptionFilter } from "@nestjs/core";
import { InvalidTransitionError } from "@market/shared";

/** Turns domain errors into HTTP responses; everything else goes to Nest's default handling. */
@Catch()
export class DomainErrorsFilter extends BaseExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    if (exception instanceof InvalidTransitionError) {
      return super.catch(new ConflictException(exception.message), host);
    }
    return super.catch(exception, host);
  }
}
