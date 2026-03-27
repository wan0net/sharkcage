export interface InboundMessage {
  channelType: "signal";
  channelId: string;
  userId: string;
  userName: string;
  text: string;
  timestamp: Date;
}

export interface OutboundMessage {
  channelType: "signal";
  channelId: string;
  text: string;
}

export interface Channel {
  name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  send(msg: OutboundMessage): Promise<void>;
  onMessage(handler: (msg: InboundMessage) => void): void;
}
