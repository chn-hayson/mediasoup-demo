#!/usr/bin/env node

process.title = 'mediasoup-demo-server';
process.env.DEBUG = process.env.DEBUG || '*INFO* *WARN* *ERROR*';

Date.prototype.format = function (fmt) {
	var o = {
		"M+": this.getMonth() + 1,                 //月份
		"d+": this.getDate(),                    //日
		"h+": this.getHours(),                   //小时
		"m+": this.getMinutes(),                 //分
		"s+": this.getSeconds(),                 //秒
		"q+": Math.floor((this.getMonth() + 3) / 3), //季度
		"S": this.getMilliseconds()             //毫秒
	};

	if (/(y+)/.test(fmt)) {
		fmt = fmt.replace(RegExp.$1, (this.getFullYear() + "").substr(4 - RegExp.$1.length));
	}

	for (var k in o) {
		if (new RegExp("(" + k + ")").test(fmt)) {
			fmt = fmt.replace(
				RegExp.$1, (RegExp.$1.length == 1) ? (o[k]) : (("00" + o[k]).substr(("" + o[k]).length)));
		}
	}

	return fmt;
}

const config = require('./config');
const urlFactory = require('./urlFactory');

/* eslint-disable no-console */
console.log('process.env.DEBUG:', process.env.DEBUG);
console.log('config.js:\n%s', JSON.stringify(config, null, '  '));
/* eslint-enable no-console */

const fs = require('fs');
const https = require('https');
const url = require('url');
const protoo = require('protoo-server');
const mediasoup = require('mediasoup');
const express = require('express');
const bodyParser = require('body-parser');
const { AwaitQueue } = require('awaitqueue');
const Logger = require('./lib/Logger');
const Room = require('./lib/Room');
const interactiveServer = require('./lib/interactiveServer');
const interactiveClient = require('./lib/interactiveClient');
const request = require('request');
const { resolve } = require('path');

const logger = new Logger();

// Async queue to manage rooms.
// @type {AwaitQueue}
const queue = new AwaitQueue();

// Map of Room instances indexed by roomId.
// @type {Map<Number, Room>}
const rooms = new Map();

// HTTPS server.
// @type {https.Server}
let httpsServer;

// Express application.
// @type {Function}
let expressApp;

// Protoo WebSocket server.
// @type {protoo.WebSocketServer}
let protooWebSocketServer;

// mediasoup Workers.
// @type {Array<mediasoup.Worker>}
const mediasoupWorkers = [];

// Index of next mediasoup Worker to use.
// @type {Number}
let nextMediasoupWorkerIdx = 0;

run();

async function run() {
	// Open the interactive server.
	await interactiveServer();

	// Open the interactive client.
	if (process.env.INTERACTIVE === 'true' || process.env.INTERACTIVE === '1')
		await interactiveClient();

	// Run a mediasoup Worker.
	await runMediasoupWorkers();

	// Create Express app.
	await createExpressApp();

	// Run HTTPS server.
	await runHttpsServer();

	// Run a protoo WebSocketServer.
	await runProtooWebSocketServer();

	// Log rooms status every X seconds.
	setInterval(() => {
		for (const room of rooms.values()) {
			room.logStatus();
		}
	}, 120000);
}

/**
 * Launch as many mediasoup Workers as given in the configuration file.
 */
async function runMediasoupWorkers() {
	const { numWorkers } = config.mediasoup;

	logger.info('running %d mediasoup Workers...', numWorkers);

	for (let i = 0; i < numWorkers; ++i) {
		const worker = await mediasoup.createWorker(
			{
				logLevel: config.mediasoup.workerSettings.logLevel,
				logTags: config.mediasoup.workerSettings.logTags,
				rtcMinPort: Number(config.mediasoup.workerSettings.rtcMinPort),
				rtcMaxPort: Number(config.mediasoup.workerSettings.rtcMaxPort)
			});

		worker.on('died', () => {
			logger.error(
				'mediasoup Worker died, exiting  in 2 seconds... [pid:%d]', worker.pid);

			setTimeout(() => process.exit(1), 2000);
		});

		mediasoupWorkers.push(worker);

		// Log worker resource usage every X seconds.
		setInterval(async () => {
			const usage = await worker.getResourceUsage();

			logger.info('mediasoup Worker resource usage [pid:%d]: %o', worker.pid, usage);
		}, 120000);
	}
}

/**
 * Create an Express based API server to manage Broadcaster requests.
 */
async function createExpressApp() {
	logger.info('creating Express app...');

	expressApp = express();

	expressApp.use(bodyParser.json());

	/**
	 * authentication handler.
	 */
	expressApp.all("*",
		(req, res, next) => {
			const accessToken = req.headers.accesstoken || '';
			authentication(accessToken).then((data) => {
				req.category = data.appId;
				req.peerId = accessToken;
				next();
			}).catch((err) => {
				logger.warn('Express app %s', String(err));

				res.status(401).send(String(err));
			});
		});

	/**
	 * For every API request, verify that the roomId in the path matches
	 */
	expressApp.param(
		'roomId', (req, res, next, roomId) => {
			// The room must exist for all API requests.
			if (!rooms.has(roomId)) {
				const error = new Error(`指定的房间不存`);

				error.status = 404;
				throw error;
			}

			const room = rooms.get(roomId);

			// The room category must be peer's belong appId
			if (room._category !== req.category) {
				const error = new Error(`无权访问其他应用的房间信息`);

				error.status = 455;
				throw error;
			}

			req.room = room;

			next();
		});

	/**
	 * For every API request, verify that the category in the path matches
	 */
	expressApp.param(
		'category', (req, res, next, category) => {
			// The room category must be peer's belong appId
			if (category !== req.category) {
				const error = new Error(`无权访问其他应用的房间信息`);

				error.status = 455;
				throw error;
			}

			next();
		});

	/**
	 * API GET resource that returns the mediasoup Router RTP capabilities of
	 * the room.
	 */
	expressApp.get(
		'/rooms/list/category/:category', (req, res) => {
			const roomList = [];

			const { category } = req.params;

			for (let item of rooms.values()) {
				if (item._category === category) {
					roomList.push({
						roomId: item._roomId,
						peersCount: item._getJoinedPeers().length,
						createTime: item._createTime
					});
				}
			}

			res.status(200).send(roomList);
		});

	/**
	 * API GET resource that returns the mediasoup Router RTP capabilities of
	 * the room.
	 */
	expressApp.get(
		'/rooms/:roomId', (req, res) => {
			const data = req.room.getRouterRtpCapabilities();

			res.status(200).json(data);
		});

	/**
	 * DELETE API to close room.
	 */
	expressApp.get(
		'/rooms/:roomId/close', (req, res) => {
			const room = req.room;
			logger.info(`room close [roomId:%s]`, room.id);

			const peer = room._protooRoom.getPeer(req.peerId);

			if (!peer || !peer.data.administrator) {
				res.status(455).send(String(`操作用户身份认证失败或不是管理员`));
			} else {
				room.close();
				res.status(200).send(true);
			}
		});

	/**
	 * DELETE API to close peer.
	 */
	expressApp.get(
		'/rooms/:roomId/peers/:toClosePeerId/close', (req, res) => {
			const { toClosePeerId } = req.params;
			logger.info(`peer close [peerId:%s]`, toClosePeerId);

			const room = req.room;
			const peer = room._protooRoom.getPeer(req.peerId);

			if (!peer || !peer.data.administrator) {
				res.status(455).send(String(`操作用户身份认证失败或不是管理员`));
			} else {
				const toClosePeer = room._protooRoom.getPeer(toClosePeerId);
				if (!toClosePeer) {
					res.status(404).send(String(`指定移除的成员不存在`));
				} else {
					if (toClosePeer.data.administrator) {
						res.status(455).send(String(`指定移除的成员不能是管理员`));
					} else {
						toClosePeer.notify('peerRemoved')
							.catch(() => { });

						toClosePeer.close();
						res.status(200).send(true);
					}
				}
			}
		});

	/**
	 * POST API to create a Broadcaster.
	 */
	expressApp.post(
		'/rooms/:roomId/broadcasters', async (req, res, next) => {
			const {
				id,
				displayName,
				device,
				rtpCapabilities
			} = req.body;

			try {
				const data = await req.room.createBroadcaster(
					{
						id,
						displayName,
						device,
						rtpCapabilities
					});

				res.status(200).json(data);
			}
			catch (error) {
				next(error);
			}
		});

	/**
	 * DELETE API to delete a Broadcaster.
	 */
	expressApp.delete(
		'/rooms/:roomId/broadcasters/:broadcasterId', (req, res) => {
			const { broadcasterId } = req.params;

			req.room.deleteBroadcaster({ broadcasterId });

			res.status(200).send('broadcaster deleted');
		});

	/**
	 * POST API to create a mediasoup Transport associated to a Broadcaster.
	 * It can be a PlainTransport or a WebRtcTransport depending on the
	 * type parameters in the body. There are also additional parameters for
	 * PlainTransport.
	 */
	expressApp.post(
		'/rooms/:roomId/broadcasters/:broadcasterId/transports',
		async (req, res, next) => {
			const { broadcasterId } = req.params;
			const { type, rtcpMux, comedia, sctpCapabilities } = req.body;

			try {
				const data = await req.room.createBroadcasterTransport(
					{
						broadcasterId,
						type,
						rtcpMux,
						comedia,
						sctpCapabilities
					});

				res.status(200).json(data);
			}
			catch (error) {
				next(error);
			}
		});

	/**
	 * POST API to connect a Transport belonging to a Broadcaster. Not needed
	 * for PlainTransport if it was created with comedia option set to true.
	 */
	expressApp.post(
		'/rooms/:roomId/broadcasters/:broadcasterId/transports/:transportId/connect',
		async (req, res, next) => {
			const { broadcasterId, transportId } = req.params;
			const { dtlsParameters } = req.body;

			try {
				const data = await req.room.connectBroadcasterTransport(
					{
						broadcasterId,
						transportId,
						dtlsParameters
					});

				res.status(200).json(data);
			}
			catch (error) {
				next(error);
			}
		});

	/**
	 * POST API to create a mediasoup Producer associated to a Broadcaster.
	 * The exact Transport in which the Producer must be created is signaled in
	 * the URL path. Body parameters include kind and rtpParameters of the
	 * Producer.
	 */
	expressApp.post(
		'/rooms/:roomId/broadcasters/:broadcasterId/transports/:transportId/producers',
		async (req, res, next) => {
			const { broadcasterId, transportId } = req.params;
			const { kind, rtpParameters } = req.body;

			try {
				const data = await req.room.createBroadcasterProducer(
					{
						broadcasterId,
						transportId,
						kind,
						rtpParameters
					});

				res.status(200).json(data);
			}
			catch (error) {
				next(error);
			}
		});

	/**
	 * POST API to create a mediasoup Consumer associated to a Broadcaster.
	 * The exact Transport in which the Consumer must be created is signaled in
	 * the URL path. Query parameters must include the desired producerId to
	 * consume.
	 */
	expressApp.post(
		'/rooms/:roomId/broadcasters/:broadcasterId/transports/:transportId/consume',
		async (req, res, next) => {
			const { broadcasterId, transportId } = req.params;
			const { producerId } = req.query;

			try {
				const data = await req.room.createBroadcasterConsumer(
					{
						broadcasterId,
						transportId,
						producerId
					});

				res.status(200).json(data);
			}
			catch (error) {
				next(error);
			}
		});

	/**
	 * POST API to create a mediasoup DataConsumer associated to a Broadcaster.
	 * The exact Transport in which the DataConsumer must be created is signaled in
	 * the URL path. Query body must include the desired producerId to
	 * consume.
	 */
	expressApp.post(
		'/rooms/:roomId/broadcasters/:broadcasterId/transports/:transportId/consume/data',
		async (req, res, next) => {
			const { broadcasterId, transportId } = req.params;
			const { dataProducerId } = req.body;

			try {
				const data = await req.room.createBroadcasterDataConsumer(
					{
						broadcasterId,
						transportId,
						dataProducerId
					});

				res.status(200).json(data);
			}
			catch (error) {
				next(error);
			}
		});

	/**
	 * POST API to create a mediasoup DataProducer associated to a Broadcaster.
	 * The exact Transport in which the DataProducer must be created is signaled in
	 */
	expressApp.post(
		'/rooms/:roomId/broadcasters/:broadcasterId/transports/:transportId/produce/data',
		async (req, res, next) => {
			const { broadcasterId, transportId } = req.params;
			const { label, protocol, sctpStreamParameters, appData } = req.body;

			try {
				const data = await req.room.createBroadcasterDataProducer(
					{
						broadcasterId,
						transportId,
						label,
						protocol,
						sctpStreamParameters,
						appData
					});

				res.status(200).json(data);
			}
			catch (error) {
				next(error);
			}
		});

	/**
	 * Error handler.
	 */
	expressApp.use(
		(error, req, res, next) => {
			if (error) {
				logger.warn('Express app %s', String(error));

				error.status = error.status || (error.name === 'TypeError' ? 400 : 500);

				res.statusMessage = error.message;
				res.status(error.status).send(String(error));
			}
			else {
				next();
			}
		});
}

/**
 * Create a Node.js HTTPS server. It listens in the IP and port given in the
 * configuration file and reuses the Express application as request listener.
 */
async function runHttpsServer() {
	logger.info('running an HTTPS server...');

	// HTTPS server for the protoo WebSocket server.
	const tls =
	{
		cert: fs.readFileSync(config.https.tls.cert),
		key: fs.readFileSync(config.https.tls.key)
	};

	httpsServer = https.createServer(tls, expressApp);

	await new Promise((resolve) => {
		httpsServer.listen(
			Number(config.https.listenPort), config.https.listenIp, resolve);
	});
}

async function authentication(peerId) {
	return new Promise(async (resolve, reject) => {
		let url = await urlFactory.getAuthenticationUrl();
		var options = {
			url: url,
			headers: {
				accessToken: peerId
			},
		};
		request.post(options, function (error, response, body) {
			body = JSON.parse(body);
			if (error || response.statusCode != 200 || body.status == "error") {
				reject("用户身份认证失败，请重试");
			} else {
				resolve(body.data);
			}
		});
	})
}

/**
 * Create a protoo WebSocketServer to allow WebSocket connections from browsers.
 */
async function runProtooWebSocketServer() {
	logger.info('running protoo WebSocketServer...');

	// Create the protoo WebSocket server.
	protooWebSocketServer = new protoo.WebSocketServer(httpsServer,
		{
			maxReceivedFrameSize: 960000, // 960 KBytes.
			maxReceivedMessageSize: 960000,
			fragmentOutgoingMessages: true,
			fragmentationThreshold: 960000
		});

	// Handle connections from clients.
	protooWebSocketServer.on('connectionrequest', (info, accept, reject) => {
		// The client indicates the roomId and peerId in the URL query.
		const u = url.parse(info.request.url, true);
		const roomId = u.query['roomId'];
		const peerId = u.query['peerId'];

		// peer authentication
		authentication(peerId).then((data) => {
			if (!roomId || !peerId) {
				reject(400, 'Connection request without roomId and/or peerId');

				return;
			}

			logger.info(
				'protoo connection request [roomId:%s, peerId:%s, address:%s, origin:%s]',
				roomId, peerId, info.socket.remoteAddress, info.origin);

			// Serialize this code into the queue to avoid that two peers connecting at
			// the same time with the same roomId create two separate rooms with same
			// roomId.
			queue.push(async () => {
				const room = await getOrCreateRoom({ roomId, category: data.appId });

				// Accept the protoo WebSocket connection.
				const protooWebSocketTransport = accept();

				room.handleProtooConnection({ peerId, protooWebSocketTransport });
			}).catch((error) => {
				logger.error('room creation or room joining failed:%o', error);

				reject(error);
			});
		}).catch((err) => {
			logger.error(err);

			reject(401, err);
			return;
		})
	});
}

/**
 * Get next mediasoup Worker.
 */
function getMediasoupWorker() {
	const worker = mediasoupWorkers[nextMediasoupWorkerIdx];

	if (++nextMediasoupWorkerIdx === mediasoupWorkers.length)
		nextMediasoupWorkerIdx = 0;

	return worker;
}

/**
 * Get a Room instance (or create one if it does not exist).
 */
async function getOrCreateRoom({ roomId, category }) {
	let room = rooms.get(roomId);

	// If the Room does not exist create a new one.
	if (!room) {

		logger.info('creating a new Room [roomId:%s] [roomCategory:%s]', roomId, category);

		const mediasoupWorker = getMediasoupWorker();
		room = await Room.create({ mediasoupWorker, roomId, category });

		rooms.set(roomId, room);
		room.on('close', () => rooms.delete(roomId));
	} else {
		if (room._category != category) {
			throw new Error('加入房间失败，成员所属应用与房间所属应用不匹配');
		}
	}

	return room;
}