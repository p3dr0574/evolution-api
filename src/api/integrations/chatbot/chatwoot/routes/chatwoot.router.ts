import { RouterBroker } from '@api/abstract/abstract.router';
import { InstanceDto } from '@api/dto/instance.dto';
import { ChatwootDto } from '@api/integrations/chatbot/chatwoot/dto/chatwoot.dto';
import { HttpStatus } from '@api/routes/index.router';
import { chatwootController } from '@api/server.module';
import { chatwootSchema, instanceSchema } from '@validate/validate.schema';
import { RequestHandler, Router } from 'express';

export class ChatwootRouter extends RouterBroker {
  constructor(...guards: RequestHandler[]) {
    super();
    this.router
      .post(this.routerPath('set'), ...guards, async (req, res) => {
        const response = await this.dataValidate<ChatwootDto>({
          request: req,
          schema: chatwootSchema,
          ClassRef: ChatwootDto,
          execute: (instance, data) => chatwootController.createChatwoot(instance, data),
        });

        res.status(HttpStatus.CREATED).json(response);
      })
      .get(this.routerPath('find'), ...guards, async (req, res) => {
        const response = await this.dataValidate<InstanceDto>({
          request: req,
          schema: instanceSchema,
          ClassRef: InstanceDto,
          execute: (instance) => chatwootController.findChatwoot(instance),
        });

        res.status(HttpStatus.OK).json(response);
      })
      .post(this.routerPath('webhook'), async (req, res) => {
        // Respond immediately so Chatwoot does not hit its 5-second timeout and retry.
        // Processing happens asynchronously; errors are logged inside receiveWebhook.
        res.status(HttpStatus.OK).json({ message: 'ok' });

        this.dataValidate<InstanceDto>({
          request: req,
          schema: instanceSchema,
          ClassRef: InstanceDto,
          execute: (instance, data) => chatwootController.receiveWebhook(instance, data),
        }).catch(() => {
          // intentionally swallowed — controller already logs failures internally
        });
      });
  }

  public readonly router: Router = Router();
}
