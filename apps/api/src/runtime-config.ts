export function resolveApiAccessToken(environment = process.env): string | undefined {
  const accessToken = environment.API_ACCESS_TOKEN?.trim() || undefined;
  const allowsUnauthenticatedAccess =
    environment.APP_ENV === 'development' || environment.APP_ENV === 'test';

  if (!allowsUnauthenticatedAccess && !accessToken) {
    throw new Error('API_ACCESS_TOKEN is required unless APP_ENV is development or test');
  }

  return accessToken;
}
