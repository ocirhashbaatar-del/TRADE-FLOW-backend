import swaggerJsdoc from 'swagger-jsdoc'
import { env } from './config/env.js'

export const openApiSpec = swaggerJsdoc({
  definition: {
    openapi: '3.0.3', info: { title: 'TradeFlow API', version: '1.0.0', description: 'TradeFlow marketplace REST API' },
    servers: [{ url: `http://localhost:${env.PORT}/api/v1` }],
    components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } }, schemas: { LoginInput: { type: 'object', required: ['email', 'password'], properties: { email: { type: 'string', format: 'email' }, password: { type: 'string', minLength: 8 } } }, Product: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' }, price: { type: 'number' }, stock: { type: 'integer' }, image: { type: 'string' } } } } },
    paths: {
      '/health': { get: { summary: 'Health check', responses: { '200': { description: 'API healthy' } } } },
      '/auth/login': { post: { summary: 'Login', requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/LoginInput' } } } }, responses: { '200': { description: 'JWT tokens and user' }, '401': { description: 'Invalid credentials' } } } },
      '/products': { get: { summary: 'List products', parameters: [{ name: 'q', in: 'query', schema: { type: 'string' } }], responses: { '200': { description: 'Product list', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Product' } } } } } } } },
      '/orders': { get: { summary: 'List current user orders', security: [{ bearerAuth: [] }], responses: { '200': { description: 'Orders' } } }, post: { summary: 'Create order', security: [{ bearerAuth: [] }], responses: { '201': { description: 'Order created' } } } },
    },
  }, apis: [],
})
