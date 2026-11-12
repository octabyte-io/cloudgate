import { Body, Controller, Post } from '@nestjs/common';
import { createZodDto } from 'nestjs-zod';
import request from 'supertest';
import { App } from 'supertest/types';
import { z } from 'zod';
import { Public } from '../../src/auth/decorators/public.decorator';
import { ErrorResponseBody } from '../../src/common/filters/all-exceptions.filter';
import { createTestApp, TestAppContext } from '../utils/test-app';

const probeSchema = z.object({
  name: z.string().min(1, 'name is required').max(255),
  email: z.email('invalid email').max(255),
});

class ProbeDto extends createZodDto(probeSchema) {}

@Public()
@Controller('zod-probe-test')
class ZodProbeController {
  @Post()
  create(@Body() body: ProbeDto) {
    return body;
  }
}

describe('AllExceptionsFilter (e2e)', () => {
  let ctx: TestAppContext;
  let server: App;

  beforeAll(async () => {
    ctx = await createTestApp({ controllers: [ZodProbeController] });
    server = ctx.app.getHttpServer() as App;
  });

  afterAll(async () => {
    await ctx.teardown();
  });

  it('returns the standard error shape for a NotFoundException', async () => {
    const res = await request(server).get('/this-route-does-not-exist');

    expect(res.status).toBe(404);
    const body = res.body as ErrorResponseBody;
    expect(body).toMatchObject({
      statusCode: 404,
      error: 'Not Found',
      path: '/this-route-does-not-exist',
    });
    expect(typeof body.message).toBe('string');
    expect(new Date(body.timestamp).toISOString()).toBe(body.timestamp);
  });

  it('returns 400 with field details for a Zod validation error', async () => {
    const res = await request(server)
      .post('/zod-probe-test')
      .send({ name: '', email: 'not-an-email' });

    expect(res.status).toBe(400);
    const body = res.body as ErrorResponseBody;
    expect(body).toMatchObject({
      statusCode: 400,
      error: 'Bad Request',
      path: '/zod-probe-test',
    });
    expect(body.details).toEqual(
      expect.arrayContaining([
        { path: 'name', message: 'name is required' },
        { path: 'email', message: 'invalid email' },
      ]),
    );
  });
});
