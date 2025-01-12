import { GatewayOpCodes } from './Util/Opcode.js';
import VoiceConnection from './Class/VoiceConnection.js';
import StreamConnection from './Class/StreamConnection.js';
import Player from './Media/Player.js';
import VoiceUDP from './Class/VoiceUDP.js';
import { Client } from 'discord.js-selfbot-v13';
import { DiscordStreamClientError, ErrorCodes } from './Util/Error.js';

class DiscordStreamClient {
	constructor(client) {
		if (!client || !(client instanceof Client)) throw new DiscordStreamClientError('NO_CLIENT');
		Object.defineProperty(this, 'client', { value: client });
		client.streamClient = this;
		this.connection = null;
		this.channel = null;
		this.selfDeaf = false;
		this.selfMute = false;
		this.selfVideo = false;
	}
	patch() {
		this.unpatch();
		this.client.on('raw', this._handleEvents);
	}
	unpatch() {
		this.client.removeListener('raw', this._handleEvents);
	}
	_handleEvents(packet) {
		if (typeof packet !== 'object' || !packet.t || !packet.d) return;
		const { t: event, d: data } = packet;
		if (event === 'VOICE_STATE_UPDATE') {
			if (data.user_id === this.user.id) {
				// transfer session data to voice connection
				this.streamClient.connection.setSession(data.session_id);
			}
		} else if (event === 'VOICE_SERVER_UPDATE') {
			// transfer voice server update to voice connection
			this.streamClient.connection.setServer(data);
		} else if (event === 'STREAM_CREATE') {
			const [type, guildId, channelId, userId] =
				data.stream_key.split(':');
			if (this.streamClient.connection.guildId != guildId) return;
			if (userId === this.user.id) {
				this.streamClient.connection.streamConnection.serverId =
					data.rtc_server_id;
				this.streamClient.connection.streamConnection.streamKey =
					data.stream_key;
				this.streamClient.connection.streamConnection.setSession(
					this.streamClient.connection.sessionId,
				);
			}
		} else if (event === 'STREAM_SERVER_UPDATE') {
			const [type, guildId, channelId, userId] =
				data.stream_key.split(':');
			if (this.streamClient.connection.guildId != guildId) return;
			if (userId === this.user.id) {
				this.streamClient.connection.streamConnection.setServer(data);
			}
		} else if (event === 'STREAM_DELETE') {
			const [type, guildId, channelId, userId] =
				data.stream_key.split(':');
			if (this.streamClient.connection.guildId != guildId) return;
			if (userId === this.user.id) {
				this.streamClient.connection.streamConnection.disconnect();
			}
		}
	}
	signalVoiceChannel({ selfDeaf, selfMute, selfVideo } = {}) {
		this.selfDeaf = selfDeaf ?? this.selfDeaf;
		this.selfMute = selfMute ?? this.selfMute;
		this.selfVideo = selfVideo ?? this.selfVideo;
		this.client.ws.broadcast({
			op: GatewayOpCodes.VOICE_STATE_UPDATE,
			d: {
				guild_id: this.channel?.guildId ?? null,
				channel_id: this.channel?.id ?? null,
				self_mute: this.selfMute,
				self_deaf: this.selfDeaf,
				self_video: this.selfVideo,
			},
		});
	}
	joinVoiceChannel(
		channel,
		{ selfMute = false, selfDeaf = false, selfVideo = false } = {},
		timeout = 30_000,
	) {
		if (!channel || !channel.isVoice() || !channel.joinable)
			throw new DiscordStreamClientError('NO_CHANNEL');
		this.patch();
		this.channel = channel;
		this.signalVoiceChannel({ selfMute, selfDeaf, selfVideo });
		this.connection = new VoiceConnection(
			this,
			channel.guildId ?? null,
			channel.id,
		);
		// Inject stream connection
		this.connection.createStream = function () {
			this.streamConnection = new StreamConnection(
				this.manager,
				this.guildId,
				this.channelId,
			);
			this.manager.signalScreenShare();
			this.manager.pauseScreenShare(false);
			return new Promise((resolve, reject) => {
				let timeoutId = setTimeout(() => {
					reject(
						new DiscordStreamClientError(
							'STREAM_CONNECTION_FAILED',
						),
					);
				}, timeout).unref();
				let i = setInterval(() => {
					if (
						this.streamConnection.sessionId &&
						this.streamConnection.token &&
						this.streamConnection.streamKey
					) {
						clearTimeout(timeoutId);
						clearInterval(i);
						resolve(this.streamConnection.connect());
					}
				}, 100).unref();
			});
		};
		return new Promise((resolve, reject) => {
			let timeoutId = setTimeout(() => {
				reject(
					new DiscordStreamClientError('JOIN_VOICE_CHANNEL_FAILED'),
				);
			}, timeout).unref();
			let i = setInterval(() => {
				if (this.connection.sessionId && this.connection.token) {
					clearTimeout(timeoutId);
					clearInterval(i);
					resolve(this.connection.connect());
				}
			}, 100).unref();
		});
	}
	leaveVoiceChannel() {
		// Todo
		this.unpatch();
		this.channel = null;
		this.signalVoiceChannel();
		this.connection = undefined;
	}
	signalScreenShare() {
		if (!this.connection?.streamConnection)
			throw new DiscordStreamClientError('NO_STREAM_CONNECTION');
		if (!this.channel || !this.channel.isVoice())
			throw new DiscordStreamClientError('MISSING_VOICE_CHANNEL');
		let data = {
			type: 'guild',
			guild_id: null,
			channel_id: this.channel.id,
			preferred_region: null,
		};
		if (['DM', 'GROUP_DM'].includes(this.channel.type)) {
			throw new DiscordStreamClientError(
				'CHANNEL_TYPE_NOT_SUPPORTED',
			);
			data.type = 'call';
		} else {
			data.guild_id = this.channel.guildId;
		}
		this.client.ws.broadcast({
			op: GatewayOpCodes.STREAM_CREATE,
			d: data,
		});
	}
	pauseScreenShare(isPause = false) {
		if (!this.connection?.streamConnection) return false;
		if (!this.channel || !this.channel.isVoice())
			throw new DiscordStreamClientError('MISSING_VOICE_CHANNEL');
		let streamKey = `guild:${this.channel.guildId}:${this.channel.id}:${this.client.user.id}`;
		if (['DM', 'GROUP_DM'].includes(this.channel.type)) {
			throw new DiscordStreamClientError('CHANNEL_TYPE_NOT_SUPPORTED');
			streamKey = `call:${this.channel.id}:${this.client.user.id}`;
		}
		this.client.ws.broadcast({
			op: GatewayOpCodes.STREAM_SET_PAUSED,
			d: {
				stream_key: streamKey,
				paused: isPause,
			},
		});
	}
	createPlayer(path, udpConnection) {
		if (!this.connection) throw new DiscordStreamClientError('NO_STREAM_CONNECTION');
		if (!(udpConnection instanceof VoiceUDP))
			throw new DiscordStreamClientError('NO_UDP')
		if (!path || typeof path !== 'string') throw new DiscordStreamClientError('NO_STREAM_PATH');
		udpConnection.voiceConnection.setSpeaking(true);
		udpConnection.voiceConnection.setVideoStatus(true);
		udpConnection.voiceConnection.manager.pauseScreenShare(false);
		const player = new Player(path, udpConnection);
		player.once('finish', () => {
			udpConnection.voiceConnection.setSpeaking(false);
			udpConnection.voiceConnection.setVideoStatus(false);
			udpConnection.voiceConnection.manager.pauseScreenShare(true);
			this.player = undefined;
		});
		return player;
	}
}

export default DiscordStreamClient;
export {
	DiscordStreamClient,
	Player,
	VoiceConnection,
	StreamConnection,
	VoiceUDP,
	DiscordStreamClientError,
	ErrorCodes,
};
