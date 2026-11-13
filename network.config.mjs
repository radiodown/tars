import { hostname, networkInterfaces } from 'node:os';

export const bindHost = '0.0.0.0';
export const frontendPort = 5173;
export const backendPort = 3001;

// Permit the machine's addresses and explicitly configured DNS names.
// Both servers use the same names when accepting browser requests.
export function allowedHosts() {
  const addresses = Object.values(networkInterfaces()).flat().filter(Boolean).map(item => item.address);
  const configured = (process.env.TARS_ALLOWED_HOSTS || '').split(',').map(value => value.trim()).filter(Boolean);
  return [...new Set(['localhost', '127.0.0.1', '::1', bindHost, hostname(), ...addresses, ...configured])]
    .map(value => value.toLowerCase().replace(/^\[|\]$/g, ''));
}
