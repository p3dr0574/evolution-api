import { ConfigService, HttpServer } from '@config/env.config';
import { Logger } from '@config/logger.config';

import { SendTextDto } from '../dto/sendMessage.dto';
import { PrismaRepository } from '../repository/repository.service';
import { getActiveToken } from '@utils/qrPublicTokens';

// Lazy circular import — same pattern as channel.service.ts using waMonitor from server.module.
// By the time any method is called, server.module is fully initialized.
import { waMonitor } from '@api/server.module';

const DEFAULT_MESSAGE =
  '⚠️ A instância *{instanceName}* foi desconectada do WhatsApp.{qrLink}';

export class DisconnectAlertService {
  private readonly logger = new Logger('DisconnectAlertService');

  /** Instances that reached connection state 'open' in this server session. */
  private readonly sessionConnected = new Set<string>();

  /** Rate-limit: instanceName → YYYY-MM-DD of the last alert sent. */
  private readonly lastAlertDate = new Map<string, string>();

  constructor(
    private readonly prismaRepository: PrismaRepository,
    private readonly configService: ConfigService,
  ) {}

  /** Call when an instance transitions to state 'open'. */
  markConnected(instanceName: string): void {
    this.sessionConnected.add(instanceName);
  }

  /**
   * Call when an instance permanently disconnects (loggedOut / forbidden).
   * Fire-and-forget: caller should `.catch()`.
   */
  async onDisconnect(instanceName: string, instanceId: string): Promise<void> {
    if (!this.sessionConnected.has(instanceName)) {
      // Was never connected in this session — ignore (API restart with already-disconnected instance)
      return;
    }

    const today = new Date().toISOString().slice(0, 10);
    if (this.lastAlertDate.get(instanceName) === today) {
      this.logger.verbose(`DisconnectAlert: already alerted today for "${instanceName}", skipping`);
      return;
    }

    const config = await this.prismaRepository.disconnectAlert
      .findUnique({ where: { instanceId } })
      .catch(() => null);

    if (!config?.enabled) return;

    // Resolve sender
    const senderName = config.senderName ?? this.findAnyConnectedInstance(instanceName);
    if (!senderName) {
      this.logger.warn(`DisconnectAlert: no connected sender instance found for "${instanceName}"`);
      return;
    }
    const sender = waMonitor.waInstances[senderName];
    if (!sender || (sender as any).connectionStatus?.state !== 'open') {
      this.logger.warn(
        `DisconnectAlert: sender "${senderName}" is not connected, skipping alert for "${instanceName}"`,
      );
      return;
    }

    // Resolve target number
    let alertTo = config.alertNumber;
    if (!alertTo) {
      const row = await this.prismaRepository.instance
        .findUnique({ where: { id: instanceId }, select: { ownerJid: true } })
        .catch(() => null);
      alertTo = row?.ownerJid?.replace(/@.*/, '') ?? null;
    }
    if (!alertTo) {
      this.logger.warn(`DisconnectAlert: no target number for instance "${instanceName}", skipping`);
      return;
    }

    // Build message
    const serverUrl = (this.configService.get<HttpServer>('SERVER') as any)?.URL ?? '';
    const qrToken = getActiveToken(instanceName);
    const qrLink = qrToken ? `${serverUrl}/qrcode/${qrToken}` : '';
    const text = (config.message ?? DEFAULT_MESSAGE)
      .replace('{instanceName}', instanceName)
      .replace('{qrLink}', qrLink ? `\n\n🔗 Reconectar: ${qrLink}` : '');

    try {
      const dto: SendTextDto = { number: alertTo, text };
      await (sender as any).textMessage(dto, true);
      this.lastAlertDate.set(instanceName, today);
      this.logger.log(
        `DisconnectAlert: alert sent for "${instanceName}" → ${alertTo} via sender "${senderName}"`,
      );
    } catch (err) {
      this.logger.error(`DisconnectAlert: failed to send for "${instanceName}": ${err}`);
    }
  }

  private findAnyConnectedInstance(excludeName: string): string | null {
    for (const [name, inst] of Object.entries(waMonitor.waInstances)) {
      if (name !== excludeName && (inst as any)?.connectionStatus?.state === 'open') {
        return name;
      }
    }
    return null;
  }
}
