import { HttpGoogleOAuthProvider } from '@ai-agents/google-oauth';
import { startApi } from './server';

startApi({
  createGoogleOAuthProvider: (config) => new HttpGoogleOAuthProvider(config),
});
