/**
 * The API, described, and served at /api/v1/openapi.json for anybody who
 * wants to build a client or poke at a server with a tool that reads it.
 */

import { VERSION } from './config.mjs'

const error = {
  type: 'object',
  properties: {
    error: {
      type: 'object',
      properties: { code: { type: 'string' }, message: { type: 'string' } },
      required: ['code', 'message'],
    },
  },
}

const room = { name: 'room', in: 'path', required: true, schema: { type: 'string', pattern: '^[0-9a-f]{32}$' } }
const person = { name: 'id', in: 'path', required: true, schema: { type: 'string', pattern: '^[0-9a-f]{64}$' } }
const write = { name: 'x-cathode-write', in: 'header', required: true, schema: { type: 'string' } }
const errors = {
  400: { description: 'Bad request', content: { 'application/json': { schema: error } } },
  403: { description: 'Wrong token', content: { 'application/json': { schema: error } } },
  429: { description: 'Too many requests', content: { 'application/json': { schema: error } } },
}
const cluster = [{ bearer: [] }]

export const openapi = {
  openapi: '3.1.0',
  info: {
    title: 'Cathode server',
    version: VERSION,
    description:
      'Keeps spaces for Cathode. Everything it holds is sealed on the device that wrote it with a key this server never sees: a space line with the key made from the space code, a person record with a key made from their identity. The server stores and relays ciphertext, and cannot read or forge any of it.',
  },
  components: {
    securitySchemes: { bearer: { type: 'http', scheme: 'bearer', description: 'CATHODE_CLUSTER_SECRET' } },
  },
  paths: {
    '/api/v1/health': {
      get: {
        summary: 'What this server is, what it offers, and the servers in its cluster',
        responses: { 200: { description: 'OK' } },
      },
    },
    '/api/v1/ice': {
      get: { summary: 'Short lived TURN credentials for calls and screen shares', responses: { 200: { description: 'OK' } } },
    },
    '/api/v1/spaces/{room}/events': {
      get: {
        summary: 'Sealed lines of a space after a point, one page at a time',
        parameters: [
          room,
          { name: 'after', in: 'query', schema: { type: 'integer', minimum: 0 } },
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 1000 } },
        ],
        responses: {
          200: {
            description: 'A page. `at` is where the next page starts; `more` says there is one.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    events: { type: 'array', items: { type: 'string' } },
                    at: { type: 'integer' },
                    more: { type: 'boolean' },
                  },
                },
              },
            },
          },
          ...errors,
        },
      },
      post: {
        summary: 'Keep sealed lines. The first write claims the space with its token.',
        parameters: [room, write],
        requestBody: {
          content: {
            'application/json': {
              schema: { type: 'object', properties: { events: { type: 'array', items: { type: 'string' } } } },
            },
          },
        },
        responses: { 200: { description: 'Kept. `added` counts the lines that were new.' }, ...errors },
      },
    },
    '/api/v1/spaces/{room}/socket': {
      get: {
        summary: 'WebSocket: history, writes, live lines and signals for one space',
        description:
          'JSON messages. In: hello {from}, get {from}, put {id, lines, w}, sig {d}. Out: page {at, lines, more}, live {at}, ev {at, lines}, ack {id, at}, nack {id, code, message}, sig {d}.',
        parameters: [room],
        responses: { 101: { description: 'Switching protocols' } },
      },
    },
    '/api/v1/people/{id}': {
      get: { summary: "A person's sealed record of their spaces", parameters: [person], responses: { 200: { description: 'OK' }, ...errors } },
      put: {
        summary: "Replace a person's sealed record. The first write claims it.",
        parameters: [person, write],
        requestBody: {
          content: { 'application/json': { schema: { type: 'object', properties: { blob: { type: 'string' } } } } },
        },
        responses: { 200: { description: 'Kept' }, ...errors },
      },
    },
    '/api/v1/preview': {
      get: {
        summary: 'The title, description and picture behind a public link',
        parameters: [{ name: 'url', in: 'query', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'OK' }, ...errors },
      },
    },
    '/api/v1/gifs': {
      get: {
        summary: 'GIF search, when the server has a Tenor key',
        parameters: [{ name: 'q', in: 'query', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'OK' }, 404: { description: 'No key' }, ...errors },
      },
    },
    '/api/v1/cluster/lines': {
      get: {
        summary: 'Between servers: every line after a number, waiting for new ones',
        security: cluster,
        parameters: [
          { name: 'after', in: 'query', schema: { type: 'integer' } },
          { name: 'limit', in: 'query', schema: { type: 'integer' } },
          { name: 'wait', in: 'query', schema: { type: 'integer', maximum: 25 } },
        ],
        responses: { 200: { description: 'OK' }, 401: { description: 'Not a server in this cluster' } },
      },
    },
    '/api/v1/cluster/rooms': {
      get: { summary: 'Between servers: the spaces and their claims', security: cluster, responses: { 200: { description: 'OK' } } },
    },
    '/api/v1/cluster/people': {
      get: { summary: 'Between servers: the sealed person records', security: cluster, responses: { 200: { description: 'OK' } } },
    },
  },
}
