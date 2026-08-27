import '@testing-library/jest-dom';
import { TextEncoder, TextDecoder } from 'util';

// jsdom's test environment doesn't provide these globally, but the AWS SDK
// (and code that mimics its stream-buffering shape in tests) expects them.
if (typeof global.TextEncoder === 'undefined') {
  global.TextEncoder = TextEncoder as unknown as typeof global.TextEncoder;
  global.TextDecoder = TextDecoder as unknown as typeof global.TextDecoder;
}
