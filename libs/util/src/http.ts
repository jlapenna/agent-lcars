export function toURLSearchParams<T>(params: T): URLSearchParams {
  const urlSearchParams = new URLSearchParams();

  for (const key in params) {
    const value = params[key as keyof T];
    if (value !== undefined && value !== null) {
      urlSearchParams.append(key, value.toString());
    }
  }

  return urlSearchParams;
}
