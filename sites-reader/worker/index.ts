import handler from "vinext/server/app-router-entry";
import {
  isAllowedSiteMethod,
  isBlockedSitePath,
  methodNotAllowedResponse,
  notFoundResponse,
  withSiteSecurityHeaders
} from "./security";

type SiteEnvironment = Record<string, unknown>;

interface SiteExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

const worker = {
  async fetch(request: Request, env: SiteEnvironment, context: SiteExecutionContext): Promise<Response> {
    if (!isAllowedSiteMethod(request.method)) {
      return withSiteSecurityHeaders(methodNotAllowedResponse());
    }
    if (isBlockedSitePath(new URL(request.url).pathname)) {
      return withSiteSecurityHeaders(notFoundResponse());
    }
    return withSiteSecurityHeaders(await handler.fetch(request, env, context));
  }
};

export default worker;
