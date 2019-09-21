/// <reference types="node" />

declare module "miniget" {
  import { PassThrough } from "stream";
  import { UrlWithStringQuery } from "url";
  import { IncomingMessage } from "http";

  export = miniget;

  function miniget(
    url: string,
    options?: miniget.MinigetOptions,
    callback?: miniget.ResponseCallback
  ): PassThrough | null;

  namespace miniget {
    type TransformUrl = (data: UrlWithStringQuery) => UrlWithStringQuery;
    type ResponseCallback = (
      error: Error,
      message: IncomingMessage,
      body: string
    ) => void;

    interface BackoffOptions {
      inc: number;
      max: number;
    }
    interface MinigetOptions {
      maxRedirects?: number;
      maxRetries?: number;
      maxReconnects?: number;
      backoff?: BackoffOptions;
      highWaterMark: number;
      transform?: TransformUrl;
      acceptEncoding?: string[];
    }
  }
}
