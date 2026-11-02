/** Where the Thekra server is. Set EXPO_PUBLIC_API_URL when building; the default is the demo server (a family of invented people). */
import { Platform } from 'react-native';

/** In a browser (the web build) the app is served by the same server as the API, so the address is empty and the browser keeps the session cookie itself. */
export const API_URL = Platform.OS === 'web' ? '' : (process.env.EXPO_PUBLIC_API_URL ?? 'https://21f06ca7-6cdf-4135-b349-d9d7a34d18d4-00-3cm7d1dlgnwq5.pike.replit.dev').replace(/\/$/, '');
