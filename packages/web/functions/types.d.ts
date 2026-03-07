type PagesFunction<E = Record<string, unknown>> = (context: {
  request: Request;
  env: E;
}) => Response | Promise<Response>;
