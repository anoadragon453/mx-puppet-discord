import {
	PuppetBridge,
	Log,
	IReceiveParams,
	IRemoteChan,
	IRemoteUser,
	IMessageEvent,
	IFileEvent,
	Util,
	IRetList,
} from "mx-puppet-bridge";
import * as Discord from "discord.js";
import {
	IDiscordMessageParserOpts,
	DiscordMessageParser,
	IMatrixMessageParserOpts,
	MatrixMessageParser,
	IDiscordMessageParserCallbacks,
} from "matrix-discord-parser";
import * as path from "path";
import * as mime from "mime";

const log = new Log("DiscordPuppet:Discord");

const MAXFILESIZE = 8000000;

interface IDiscordPuppet {
	client: Discord.Client;
	data: any;
}

interface IDiscordPuppets {
	[puppetId: number]: IDiscordPuppet;
}

export class DiscordClass {
	private puppets: IDiscordPuppets = {};
	private discordMsgParser: DiscordMessageParser;
	private matrixMsgParser: MatrixMessageParser;
	constructor(
		private puppet: PuppetBridge,
	) {
		this.discordMsgParser = new DiscordMessageParser();
		this.matrixMsgParser = new MatrixMessageParser();
	}

	public getRemoteUser(puppetId: number, user: Discord.User): IRemoteUser {
		return {
			userId: user.id,
			puppetId,
			avatarUrl: user.avatarURL,
			name: user.username,
		};
	}

	public getRemoteChan(puppetId: number, channel: Discord.Channel, dmId: string): IRemoteChan {
		const ret = {
			roomId: channel.type === "dm" ? dmId : channel.id,
			puppetId,
			isDirect: channel.type === "dm",
		} as IRemoteChan;
		if (channel.type === "text") {
			const textChannel = channel as Discord.TextChannel;
			ret.name = `#${textChannel.name} - ${textChannel.guild.name}`;
			ret.avatarUrl = textChannel.guild.iconURL;
		}
		return ret;
	}

	public async getRemoteChanById(puppetId: number, id: string): Promise<IRemoteChan | null> {
		const p = this.puppets[puppetId];
		if (!p) {
			return null;
		}
		const chan = await this.getDiscordChan(p.client, id);
		if (!chan) {
			return null;
		}
		return this.getRemoteChan(puppetId, chan, id);
	}

	public getSendParams(puppetId: number, msg: Discord.Message | Discord.Channel, user?: Discord.User): IReceiveParams {
		let channel: Discord.Channel;
		let eventId: string | undefined;
		if (!user) {
			channel = (msg as Discord.Message).channel;
			user = (msg as Discord.Message).author;
			eventId = (msg as Discord.Message).id;
		} else {
			channel = msg as Discord.Channel;
		}
		return {
			chan: this.getRemoteChan(puppetId, channel, `dm-${user.id}`),
			user: this.getRemoteUser(puppetId, user),
			eventId,
		} as IReceiveParams;
	}

	public async insertNewEventId(puppetId: number, matrixId: string, msgs: Discord.Message | Discord.Message[]) {
		if (!Array.isArray(msgs)) {
			msgs = [msgs];
		}
		for (const m of msgs) {
			await this.puppet.eventStore.insert(puppetId, matrixId, m.id);
		}
	}

	public async handleMatrixMessage(room: IRemoteChan, data: IMessageEvent, event: any) {
		const p = this.puppets[room.puppetId];
		if (!p) {
			return;
		}
		const chan = await this.getDiscordChan(p.client, room.roomId);
		if (!chan) {
			log.warn("Channel not found", room);
			return;
		}

		const sendMsg = await this.parseMatrixMessage(room.puppetId, event.content);
		const reply = await chan.send(sendMsg);
		await this.insertNewEventId(room.puppetId, data.eventId!, reply);
	}

	public async handleMatrixFile(room: IRemoteChan, data: IFileEvent, event: any) {
		const p = this.puppets[room.puppetId];
		if (!p) {
			return;
		}
		const chan = await this.getDiscordChan(p.client, room.roomId);
		if (!chan) {
			log.warn("Channel not found", room);
			return;
		}

		let size = data.info ? data.info.size || 0 : 0;
		const mimetype = data.info ? data.info.mimetype || "" : "";
		if (size < MAXFILESIZE) {
			const attachment = await Util.DownloadFile(data.url);
			size = attachment.byteLength;
			if (size < MAXFILESIZE) {
				// send as attachment
				const filename = this.getFilenameForMedia(data.filename, mimetype);
				const reply = await chan!.send(new Discord.Attachment(attachment, filename));
				await this.insertNewEventId(room.puppetId, data.eventId!, reply);
				return;
			}
		}
		if (mimetype && mimetype.split("/")[0] === "image") {
			const embed = new Discord.RichEmbed()
				.setTitle(data.filename)
				.setImage(data.url);
			const reply = await chan.send(embed);
			await this.insertNewEventId(room.puppetId, data.eventId!, reply);
		} else {
			const reply = await chan.send(`Uploaded File: [${data.filename}](${data.url})`);
			await this.insertNewEventId(room.puppetId, data.eventId!, reply);
		}
	}

	public async handleMatrixRedact(room: IRemoteChan, eventId: string, event: any) {
		const p = this.puppets[room.puppetId];
		if (!p) {
			return;
		}
		const chan = await this.getDiscordChan(p.client, room.roomId);
		if (!chan) {
			log.warn("Channel not found", room);
			return;
		}
		log.verbose(`Deleting message with ID ${eventId}...`);
		const msg = await chan.fetchMessage(eventId);
		if (!msg) {
			return;
		}
		await msg.delete();
	}

	public async handleMatrixEdit(room: IRemoteChan, eventId: string, data: IMessageEvent, event: any) {
		const p = this.puppets[room.puppetId];
		if (!p) {
			return;
		}
		const chan = await this.getDiscordChan(p.client, room.roomId);
		if (!chan) {
			log.warn("Channel not found", room);
			return;
		}
		log.verbose(`Editing message with ID ${eventId}...`);
		const msg = await chan.fetchMessage(eventId);
		if (!msg) {
			return;
		}
		const sendMsg = await this.parseMatrixMessage(room.puppetId, event.content["m.new_content"]);
		const reply = await msg.edit(sendMsg);
		await this.insertNewEventId(room.puppetId, data.eventId!, reply);
	}

	public async handleMatrixReply(room: IRemoteChan, eventId: string, data: IMessageEvent, event: any) {
		const p = this.puppets[room.puppetId];
		if (!p) {
			return;
		}
		const chan = await this.getDiscordChan(p.client, room.roomId);
		if (!chan) {
			log.warn("Channel not found", room);
			return;
		}
		log.verbose(`Replying to message with ID ${eventId}...`);
		const msg = await chan.fetchMessage(eventId);
		if (!msg) {
			return;
		}
		const sendMsg = await this.parseMatrixMessage(room.puppetId, event.content);
		const replyEmbed = new Discord.RichEmbed()
			.setTimestamp(new Date(msg.createdAt))
			.setDescription(msg.content)
			.setAuthor(msg.author.username, msg.author.avatarURL);
		if (msg.embeds && msg.embeds[0]) {
			const msgEmbed = msg.embeds[0];
			// if an author is set it wasn't an image embed thingy we send
			if (msgEmbed.image && !msgEmbed.author) {
				replyEmbed.setImage(msgEmbed.image.url);
			}
		}
		if (msg.attachments.first()) {
			const attach = msg.attachments.first();
			if (attach.height) {
				// image!
				replyEmbed.setImage(attach.proxyURL);
			} else {
				replyEmbed.description += `[${attach.filename}](attach.proxyURL)`;
			}
		}
		const reply = await chan.send(sendMsg, replyEmbed);
		await this.insertNewEventId(room.puppetId, data.eventId!, reply);
	}

	public async handleMatrixReaction(room: IRemoteChan, eventId: string, reaction: string, event: any) {
		const p = this.puppets[room.puppetId];
		if (!p) {
			return;
		}
		const chan = await this.getDiscordChan(p.client, room.roomId);
		if (!chan) {
			log.warn("Channel not found", room);
			return;
		}
		log.verbose(`Reacting to ${eventId} with ${reaction}...`);
		const msg = await chan.fetchMessage(eventId);
		if (!msg) {
			return;
		}
		await msg.react(reaction);
	}

	public async handleDiscordMessage(puppetId: number, msg: Discord.Message) {
		const p = this.puppets[puppetId];
		if (!p) {
			return;
		}
		if (msg.author.id === p.client.user.id) {
			return; // TODO: proper filtering for double-puppetting
		}
		log.info("Received new message!");
		if (!this.bridgeChannel(puppetId, msg.channel)) {
			log.info("Only handling DM channels, dropping message...");
			return;
		}
		const params = this.getSendParams(puppetId, msg);
		for ( const [_, attachment] of Array.from(msg.attachments)) {
			await this.puppet.sendFileDetect(params, attachment.url, attachment.filename);
		}
		if (msg.content) {
			const opts = {
				callbacks: this.getDiscordMsgParserCallbacks(puppetId),
			} as IDiscordMessageParserOpts;
			const reply = await this.discordMsgParser.FormatMessage(opts, msg);
			await this.puppet.sendMessage(params, {
				body: reply.body,
				formattedBody: reply.formattedBody,
				emote: reply.msgtype === "m.emote",
				notice: reply.msgtype === "m.notice",
			});
		}
	}

	public async handleDiscordMessageUpdate(puppetId: number, msg1: Discord.Message, msg2: Discord.Message) {
		const p = this.puppets[puppetId];
		if (!p) {
			return;
		}
		if (msg1.author.id === p.client.user.id) {
			return; // TODO: proper filtering for double-puppetting
		}
		if (!this.bridgeChannel(puppetId, msg1.channel)) {
			log.info("Only handling DM channels, dropping message...");
			return;
		}
		const params = this.getSendParams(puppetId, msg1);
		const opts = {
			callbacks: this.getDiscordMsgParserCallbacks(puppetId),
		} as IDiscordMessageParserOpts;
		const reply = await this.discordMsgParser.FormatMessage(opts, msg2);
		await this.puppet.sendEdit(params, msg1.id, {
			body: reply.body,
			formattedBody: reply.formattedBody,
			emote: reply.msgtype === "m.emote",
			notice: reply.msgtype === "m.notice",
		});
	}

	public async handleDiscordMessageDelete(puppetId: number, msg: Discord.Message) {
		const p = this.puppets[puppetId];
		if (!p) {
			return;
		}
		if (msg.author.id === p.client.user.id) {
			return; // TODO: proper filtering for double-puppetting
		}
		if (!this.bridgeChannel(puppetId, msg.channel)) {
			log.info("Only handling DM channels, dropping message...");
			return;
		}
		const params = this.getSendParams(puppetId, msg);
		await this.puppet.sendRedact(params, msg.id);
	}

	public async newPuppet(puppetId: number, data: any) {
		log.info(`Adding new Puppet: puppetId=${puppetId}`);
		if (this.puppets[puppetId]) {
			await this.deletePuppet(puppetId);
		}
		const client = new Discord.Client();
		client.on("ready", async () => {
			const d = this.puppets[puppetId].data;
			d.username = client.user.tag;
			d.id = client.user.id;
			await this.puppet.setUserId(puppetId, client.user.id);
			await this.puppet.setPuppetData(puppetId, d);
		});
		client.on("message", async (msg: Discord.Message) => {
			await this.handleDiscordMessage(puppetId, msg);
		});
		client.on("messageUpdate", async (msg1: Discord.Message, msg2: Discord.Message) => {
			await this.handleDiscordMessageUpdate(puppetId, msg1, msg2);
		});
		client.on("messageDelete", async (msg: Discord.Message) => {
			await this.handleDiscordMessageDelete(puppetId, msg);
		});
		client.on("messageDeleteBulk", async (msgs: Discord.Collection<Discord.Snowflake, Discord.Message>) => {
			for (const [_, msg] of Array.from(msgs)) {
				await this.handleDiscordMessageDelete(puppetId, msg);
			}
		});
		client.on("typingStart", async (chan: Discord.Channel, user: Discord.User) => {
			const params = this.getSendParams(puppetId, chan, user);
			await this.puppet.setUserTyping(params, true);
		});
		client.on("typingStop", async (chan: Discord.Channel, user: Discord.User) => {
			const params = this.getSendParams(puppetId, chan, user);
			await this.puppet.setUserTyping(params, false);
		});
		client.on("presenceUpdate", async (_, member: Discord.GuildMember) => {
			const user = member.user;
			const matrixPresence = {
				online: "online",
				idle: "unavailable",
				dnd: "unavailable",
				offline: "offline",
			}[user.presence.status] as "online" | "offline" | "unavailable";
			const statusMsg = member.presence.game ? member.presence.game.name : "";
			const remoteUser = this.getRemoteUser(puppetId, user);
			await this.puppet.setUserPresence(remoteUser, matrixPresence);
			await this.puppet.setUserStatus(remoteUser, statusMsg);
		});
		client.on("messageReactionAdd", async (reaction: Discord.MessageReaction, user: Discord.User) => {
			if (reaction.me) {
				return; // TODO: filter this out better
			}
			const chan = reaction.message.channel;
			if (!this.bridgeChannel(puppetId, chan)) {
				return;
			}
			const params = this.getSendParams(puppetId, chan, user);
			await this.puppet.sendReaction(params, reaction.message.id, reaction.emoji.name);
		});
		this.puppets[puppetId] = {
			client,
			data,
		};
		await client.login(data.token);
	}

	public async deletePuppet(puppetId: number) {
		log.info(`Got signal to quit Puppet: puppetId=${puppetId}`);
		const p = this.puppet[puppetId];
		if (!p) {
			return; // nothing to do
		}
		await p.client.destroy();
		delete this.puppet[puppetId];
	}

	public async createChan(chan: IRemoteChan): Promise<IRemoteChan | null> {
		return await this.getRemoteChanById(chan.puppetId, chan.roomId);
	}

	public async createUser(user: IRemoteUser): Promise<IRemoteUser | null> {
		const p = this.puppets[user.puppetId];
		if (!p) {
			return null;
		}
		const u = this.getUserById(p.client, user.userId);
		if (!u) {
			return null;
		}
		return this.getRemoteUser(user.puppetId, u);
	}

	public async getDmRoom(user: IRemoteUser): Promise<string | null> {
		const p = this.puppets[user.puppetId];
		if (!p) {
			return null;
		}
		const u = this.getUserById(p.client, user.userId);
		if (!u) {
			return null;
		}
		return `dm-${u.id}`;
	}

	public async listUsers(puppetId: number): Promise<IRetList[]> {
		const ret: IRetList[] = [];
		const p = this.puppets[puppetId];
		if (!p) {
			return [];
		}
		for (const [_, guild] of Array.from(p.client.guilds)) {
			ret.push({
				category: true,
				name: guild.name,
			});
			for (const [__, member] of Array.from(guild.members)) {
				ret.push({
					name: member.user.username,
					id: member.user.id,
				});
			}
		}
		return ret;
	}

	private bridgeChannel(puppetId: number, chan: Discord.Channel): boolean {
		return chan.type === "dm"; // currently we only allow dm bridging
	}

	private async parseMatrixMessage(puppetId: number, eventContent: any): Promise<string> {
		const opts = {
			displayname: "", // something too short
			callbacks: {
				canNotifyRoom: async () => true,
				getUserId: async (mxid: string) => {
					const parts = this.puppet.userSync.getPartsFromMxid(mxid);
					if (!parts || parts.puppetId !== puppetId) {
						return null;
					}
					return parts.userId;
				},
				getChannelId: async (mxid: string) => null,
				getEmojiId: async (mxc: string, name: string) => null, // TODO: handle emoji
				mxcUrlToHttp: (mxc: string) => this.puppet.getUrlFromMxc(mxc),
			},
		} as IMatrixMessageParserOpts;
		const msg = await this.matrixMsgParser.FormatMessage(opts, eventContent);
		return msg;
	}

	private getUserById(client: Discord.Client, id: string): Discord.User | null {
		for (const [_, guild] of Array.from(client.guilds)) {
			const a = guild.members.find((m) => m.user.id === id);
			if (a) {
				return a.user as Discord.User;
			}
		}
		return null;
	}

	private async getDiscordChan(
		client: Discord.Client, id: string,
	): Promise<Discord.DMChannel | Discord.TextChannel | null> {
		if (!id.startsWith("dm-")) {
			// we have a guild textChannel
			for (const [_, guild] of Array.from(client.guilds)) {
				const chan = guild.channels.get(id);
				if (chan && chan.type === "text") {
					return chan as Discord.TextChannel;
				}
			}
			return null; // nothing found
		} else {
			// we have a DM channel
			const lookupId = id.substring("dm-".length);
			const user = this.getUserById(client, lookupId);
			if (!user) {
				return null;
			}
			const chan = await user.createDM();
			return chan;
		}
	}

	private getDiscordMsgParserCallbacks(puppetId: number) {
		const p = this.puppets[puppetId];
		return {
			getUser: async (id: string) => {
				const mxid = await this.puppet.getMxidForUser({
					puppetId,
					userId: id,
				});
				let name = mxid;
				const user = this.getUserById(p.client, id);
				if (user) {
					name = user.username;
				}
				return {
					mxid,
					name,
				};
			},
			getChannel: async (id: string) => null, // we don't handle channels
			getEmoji: async (name: string, animated: boolean, id: string) => null, // TODO: handle emoji
		} as IDiscordMessageParserCallbacks;
	}

	private getFilenameForMedia(filename: string, mimetype: string): string {
		let ext = "";
		const mimeExt = mime.getExtension(mimetype);
		if (mimeExt) {
			ext = "." + mimeExt;
		}
		if (filename) {
			if (path.extname(filename) !== "") {
				return filename;
			}
			return path.basename(filename) + ext;
		}
		return "matrix-media" + ext;
	}
}
