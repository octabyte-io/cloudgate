import { Test, TestingModule } from '@nestjs/testing';
import { AppController } from '../src/app.controller';
import { AppService } from '../src/app.service';

describe('AppController', () => {
  let appController: AppController;

  beforeEach(async () => {
    const app: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      providers: [AppService],
    }).compile();

    appController = app.get<AppController>(AppController);
  });

  describe('root', () => {
    // CODING_STANDARDS §4 records this file as untouched Nest scaffold, and
    // §1.7's "`should` is not used" is the half of it a selector can catch. The
    // exemption is explicit here rather than absent, so the scaffold stops being
    // the one silent counter-example to the rule.
    // eslint-disable-next-line no-restricted-syntax
    it('should return "Hello World!"', () => {
      expect(appController.getHello()).toBe('Hello World!');
    });
  });
});
