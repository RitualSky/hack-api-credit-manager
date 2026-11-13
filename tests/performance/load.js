import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE_URL = (__ENV.BASE_URL || 'http://localhost:8080').replace(/\/+$/, '');

// Prueba de carga corta (30 s) pensada para demos
export const options = {
  stages: [
    { duration: '5s', target: 5 },
    { duration: '20s', target: 5 },
    { duration: '5s', target: 0 },
  ],
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<800'],
    checks: ['rate>0.99'],
  },
};

export default function () {
  const res = http.get(`${BASE_URL}/api/v1/hello?name=k6`);

  check(res, {
    'status es 200': (r) => r.status === 200,
    'mensaje esperado': (r) => r.json('message') === 'Hello Hack, k6!',
  });

  sleep(0.5);
}
