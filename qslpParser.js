/*
*
* QSLP - Version 2.0.0
*
* Qredit Always Evolving
*
* A simplified token management system for the Qredit network
*
* QSLPParser - Parse the blockchain for QSLP items
*
*/

const redis = require('redis');			 // a really fast nosql keystore
const fs = require('fs');				 // so we can read the config ini file from disk
const ini = require('ini');				 // so we can parse the ini files properties
const Big = require('big.js');			 // required unless you want floating point math issues
const nodemailer = require('nodemailer');		 // for sending error reports about this node
const crypto = require('crypto');			 // for creating hashes of things
const SparkMD5 = require('spark-md5');  		 // Faster than crypto for md5
const { promisify } = require('util');			 // Promise functions
const asyncv3 = require('async');			 // Async Helper
const { Client } = require('pg');				 // Postgres
const qreditjs = require("qreditjs");

const { onShutdown } = require('node-graceful-shutdown');

var shuttingdown = false;
var safetoshutdown = false;

// On Shutdown - Do some Cleanup
onShutdown("parser", async function () {

	shuttingdown = true;

	return new Promise((resolve, reject) => {

		var shutdowncheck = setInterval(function () {

			console.log('Checking if shutdown is safe... ' + safetoshutdown.toString());
			if (safetoshutdown == true) {
				resolve(true);
			}

		}, 1000);

	});

});

var iniconfig = ini.parse(fs.readFileSync('qslp.ini', 'utf-8'))

// Mongo Connection Details
const mongoconnecturl = iniconfig.mongo_connection_string;
const mongodatabase = iniconfig.mongo_database;

// MongoDB Library
const QSLPDB = require("./lib/qslpDB");
const qdb = new QSLPDB.default(mongoconnecturl, mongodatabase);

// Connect to Redis and setup some async call definitions
const rclient = redis.createClient(iniconfig.redis_port, iniconfig.redis_host, { detect_buffers: true });
const rclienttwo = redis.createClient(iniconfig.redis_port, iniconfig.redis_host, { detect_buffers: true });
const hgetAsync = promisify(rclient.hget).bind(rclient);
const hsetAsync = promisify(rclient.hset).bind(rclient);
const getAsync = promisify(rclient.get).bind(rclient);
const setAsync = promisify(rclient.set).bind(rclient);
const delAsync = promisify(rclient.del).bind(rclient);

// QSLP-1 Token Schema
const QSLPSchema = require("./lib/qslpSchema");
const qslp = new QSLPSchema.default();

const QSLPactivationHeight = 1579800;
const QSLPactivationBlockId = '2d807820a21846be886e7cc96c1ce889b02a23db0d2d47113b80927c263276e6';

// Declaring some variable defaults

var scanBlockId = 0;
var lastBlockId = '';
var sigblockhash = '';
var sigtokenhash = '';
var sigaddrhash = '';
var sigtrxhash = '';
var previoushash = '';
var fullhash = '';
var processedItems = false;
var lastBlockNotify = Math.floor(new Date() / 1000);

var scanLock = false;
var scanLockTimer = 0;

// Let us know when we connect or have an error with redis
rclient.on('connect', function () {
	console.log('Connected to Redis');
});

rclient.on('error', function () {
	console.log("Error in Redis");
	error_handle("Error in Redis", 'redisConnection');
});

// Rescan Flag or Unknown last scan -  rescans all transaction (ie. #node QSLPApiv2.js true)

rclient.get('QSLP_lastscanblock', function (err, lbreply) {

	if ((process.argv.length == 3 && (process.argv[2] == '1' || process.argv[2] == 'true')) || lbreply == null || parseInt(lbreply) != lbreply) {

		(async () => {

			console.log("--------------------");
			console.log("Forcing a Rescan....");
			console.log("--------------------");

			await delAsync('QSLP_lastscanblock');
			await delAsync('QSLP_lastblockid');

			await setAsync('QSLP_lastscanblock', QSLPactivationHeight);
			await setAsync('QSLP_lastblockid', QSLPactivationBlockId);

			// Remove items from MongoDB

			let response = {};
			let exists = true;

			var mclient = await qdb.connect();
			qdb.setClient(mclient);

			exists = await qdb.doesCollectionExist('tokens');
			console.log("Does collection 'tokens' Exist: " + exists);
			if (exists == true) {
				console.log("Removing all documents from 'tokens'");
				await qdb.removeDocuments('tokens', {});
			}
			else {
				console.log("Creating new collection 'tokens'");
				await qdb.createCollection('tokens', {});
			}

			exists = await qdb.doesCollectionExist('addresses');
			console.log("Does collection 'addresses' Exist: " + exists);
			if (exists == true) {
				console.log("Removing all documents from 'addresses'");
				await qdb.removeDocuments('addresses', {});
			}
			else {
				console.log("Creating new collection 'addresses'");
				await qdb.createCollection('addresses', {});
			}

			exists = await qdb.doesCollectionExist('transactions');
			console.log("Does collection 'transactions' Exist: " + exists);
			if (exists == true) {
				console.log("Removing all documents from 'transactions'");
				await qdb.removeDocuments('transactions', {});
			}
			else {
				console.log("Creating new collection 'transactions'");
				await qdb.createCollection('transactions', {});
			}

			exists = await qdb.doesCollectionExist('journal');
			console.log("Does collection 'journal' Exist: " + exists);
			if (exists == true) {
				console.log("Removing all documents from 'journal'");
				await qdb.removeDocuments('journal', {});
			}
			else {
				console.log("Creating new collection 'journal'");
				await qdb.createCollection('journal', {});
			}

			exists = await qdb.doesCollectionExist('metadata');
			console.log("Does collection 'metadata' Exist: " + exists);
			if (exists == true) {
				console.log("Removing all documents from 'metadata'");
				await qdb.removeDocuments('metadata', {});
			}
			else {
				console.log("Creating new collection 'metadata'");
				await qdb.createCollection('metadata', {});
			}

			exists = await qdb.doesCollectionExist('counters');
			console.log("Does collection 'counters' Exist: " + exists);
			if (exists == true) {
				console.log("Removing all documents from 'counters'");
				await qdb.removeDocuments('counters', {});
			}

			await qslp.indexDatabase(qdb);

			await qdb.close();

			// Initialze things
			initialize();

		})();

	}
	else {
		// Initialze things
		initialize();
	}

});


// Main Functions
// ==========================

function initialize() {

	downloadChain();
	blockNotifyQueue();

}

function blockNotifyQueue() {

	rclienttwo.blpop('blockNotify', iniconfig.polling_interval, function (err, data) {

		if (data == 'blockNotify,new') {
			newblocknotify();
		}
		else {
			var currentIntervalTime = Math.floor(new Date() / 1000);
			if (lastBlockNotify < (currentIntervalTime - iniconfig.polling_interval)) {
				newblocknotify();
			}
		}

		blockNotifyQueue();

	});

}

function downloadChain() {

	scanLock = true;
	scanLockTimer = Math.floor(new Date() / 1000);

	(async () => {

		var pgclient = new Client({ user: iniconfig.pg_username, database: iniconfig.pg_database, password: iniconfig.pg_password });
		await pgclient.connect()
		var message = await pgclient.query('SELECT * FROM blocks ORDER BY height DESC LIMIT 1')
		await pgclient.end()


		var topHeight = 0;
		if (message && message.rows && message.rows[0].height) {
			var topHeight = message.rows[0].height;
			lastBlockId = message.rows[0].id;
		}

		console.log('Qredit Current Top Height #' + topHeight + '.....');

		scanLock = false;
		scanLockTimer = 0;

		doScan();

	})();

}

function syncJournalFromPeer() {





}

function rebuildDbFromJournal() {





}

function doScan() {

	scanLock = true;
	scanLockTimer = Math.floor(new Date() / 1000);

	rclient.get('QSLP_lastscanblock', function (err, reply) {

		if (err) {
			console.log(err);
		}
		else if (reply == null || parseInt(reply) != reply) {
			scanBlockId = QSLPactivationHeight;
		}
		else {
			scanBlockId = parseInt(reply);
		}

		//

		rclient.get('QSLP_lastblockid', function (err, replytwo) {

			if (err) {
				console.log(err);
			}
			else if (reply == null) {
				lastBlockId = '';
			}
			else {
				lastBlockId = replytwo;
			}


			//

			console.log('Scanning from block #' + scanBlockId + '.....');

			(async () => {

				var currentHeight = 0;

				var pgclient = new Client({ user: iniconfig.pg_username, database: iniconfig.pg_database, password: iniconfig.pg_password });
				await pgclient.connect()
				var message = await pgclient.query('SELECT * FROM blocks ORDER BY height DESC LIMIT 1');

				if (message && message.rows) currentHeight = parseInt(message.rows[0].height);

				console.log('Current Blockchain Height: ' + currentHeight);

				var mclient = await qdb.connect();
				qdb.setClient(mclient);

				await whilstScanBlocks(scanBlockId, currentHeight, pgclient, qdb);

			})();

		});

	});

}


async function whilstScanBlocks(count, max, pgclient, qdb) {

	return new Promise((resolve) => {

		asyncv3.whilst(
			function test(cb) { cb(null, count < max) },
			function iter(callback) {

				if (shuttingdown == true) {

					safetoshutdown = true;

				}
				else {

					count++;

					scanLockTimer = Math.floor(new Date() / 1000);

					if (count % 1000 == 0 || count == max) console.log("Scanning: " + count);

					pgclient.query('SELECT id, number_of_transactions, height, previous_block FROM blocks WHERE height = $1 LIMIT 1', [count], (err, message) => {

						if (message && message.rows) {

							var blockdata = message.rows[0];

							if (blockdata && blockdata.id) {

								var blockidcode = blockdata.id;
								var blocktranscount = blockdata.number_of_transactions;
								var thisblockheight = blockdata.height;

								var previousblockid = blockdata.previous_block;

								if (lastBlockId != previousblockid && thisblockheight > 1) {

									console.log('Error:	 Last Block ID is incorrect!  Rescan Required!');

									console.log("Expected: " + previousblockid);
									console.log("Received: " + lastBlockId);
									console.log("ThisBlockHeight: " + thisblockheight);
									console.log("LastScanBlock: " + count);

									rclient.del('QSLP_lastblockid', function (err, reply) {
										rclient.del('QSLP_lastscanblock', function (err, reply) {
											process.exit(-1);
										});
									});

								}

								lastBlockId = blockidcode;

								processedItems = false;

								if (parseInt(blocktranscount) > 0 && thisblockheight >= QSLPactivationHeight) {

									pgclient.query('SELECT * FROM transactions WHERE block_id = $1 ORDER BY sequence ASC', [blockidcode], (err, tresponse) => {

										if (tresponse && tresponse.rows) {

											(async () => {

												for (let ti = 0; ti < tresponse.rows.length; ti++) {

													var origtxdata = tresponse.rows[ti];

													var epochdate = new Date(Date.parse('2017-03-21 13:00:00'));
													var unixepochtime = Math.round(epochdate.getTime() / 1000);

													var unixtimestamp = parseInt(origtxdata.timestamp) + unixepochtime;
													var humantimestamp = new Date(unixtimestamp * 1000).toISOString();

													var txdata = {};
													txdata.id = origtxdata.id
													txdata.blockId = origtxdata.block_id;
													txdata.version = origtxdata.version;
													txdata.type = origtxdata.type;
													txdata.amount = origtxdata.amount;
													txdata.fee = origtxdata.fee;
													txdata.sender = qreditjs.crypto.getAddress(origtxdata.sender_public_key);
													txdata.senderPublicKey = origtxdata.sender_public_key;
													txdata.recipient = origtxdata.recipient_id
													if (origtxdata.vendor_field != null && origtxdata.vendor_field != '') {
														try {
															txdata.vendorField = origtxdata.vendor_field.toString(); //hex_to_ascii(origtxdata.vendor_field);
														}
														catch (e) {
															txdata.vendorField = null;
														}
													}
													else {
														txdata.vendorField = null;
													}
													txdata.confirmations = parseInt(max) - parseInt(thisblockheight);
													txdata.timestamp = { epoch: origtxdata.timestamp, unix: unixtimestamp, human: humantimestamp };

													if (txdata.vendorField && txdata.vendorField != '') {

														var isjson = false;

														try {
															JSON.parse(txdata.vendorField);
															isjson = true;
														} catch (e) {
															//console.log("VendorField is not JSON");
														}

														if (isjson === true) {

															var parsejson = JSON.parse(txdata.vendorField);

															if (parsejson.QSLP1) {

																console.log(txdata);

																var txmessage = await qdb.findDocuments('transactions', { "txid": txdata.id });
																if (txmessage.length == 0) {
																	try {
																		var QSLPresult = await qslp.parseTransaction(txdata, blockdata, qdb);
																	} catch (e) {
																		error_handle(e, 'parseTransaction', 'error');
																	}
																	processedItems = true;
																}
																else {
																	console.log('ERROR:	 We already have TXID: ' + txdata.id);
																}

															}
															else if (parsejson.QSLP2) {

																console.log(txdata);

																var txmessage = await qdb.findDocuments('metadata', { "txid": txdata.id });
																if (txmessage.length == 0) {
																	try {
																		var QSLPresult = await qslp.parseTransaction(txdata, blockdata, qdb);
																	} catch (e) {
																		error_handle(e, 'parseTransaction', 'error');
																	}
																	processedItems = true;
																}
																else {
																	console.log('ERROR:	 We already have TXID: ' + txdata.id);
																}

															}

														}

													}



												}

												// No longer use

												await setAsync('QSLP_lastscanblock', thisblockheight);
												await setAsync('QSLP_lastblockid', blockidcode);

												callback(null, count);

											})();

										}
										else {
											// This needs to be handled.  TODO:	 Missing transactions when there should be some
											callback(null, count);
										}

									});

								}
								else {
									(async () => {

										// No longer use

										await setAsync('QSLP_lastscanblock', thisblockheight);
										await setAsync('QSLP_lastblockid', blockidcode);

										try {
											callback(null, count);
										} catch (e) {
											console.log(e);
										}

									})();

								}

							}
							else {

								console.log("Block #" + count + " missing blockdata info.. This is a fatal error...");
								process.exit(-1);

							}

						}
						else {

							console.log("Block #" + count + " not found in database.. This is a fatal error...");
							process.exit(-1);

						}

					});


				}

			},
			function (err, n) {

				(async () => {

					await qdb.close();
					await pgclient.end()

					scanLock = false;
					scanLockTimer = 0;

					resolve(true);

				})();

			}

		);

	});

}

function newblocknotify() {

	lastBlockNotify = Math.floor(new Date() / 1000);

	console.log('New Block Notify..');

	if (scanLock == true) {
		// TODO:  Check if it is a stale lock
		var currentUnixTime = Math.floor(new Date() / 1000);
		if (scanLockTimer < (currentUnixTime - iniconfig.scanlock_staletime)) {
			// force unlock
			console.log("Forcing scanlock Unlock....");
			scanLock = false;
		}


		console.log('Scanner already running...');
	}
	else {
		downloadChain();
	}

	return true;

}





// Helpers
// ==========================

function hex_to_ascii(str1) {
	var hex = str1.toString();
	var str = '';
	for (var n = 0; n < hex.length; n += 2) {
		str += String.fromCharCode(parseInt(hex.substr(n, 2), 16));
	}
	return str;
}

function decimalPlaces(num) {
	var match = (Big(num).toString()).match(/(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/);
	if (!match) { return 0; }
	return Math.max(
		0,
		// Number of digits right of decimal point.
		(match[1] ? match[1].length : 0)
		// Adjust for scientific notation.
		- (match[2] ? +match[2] : 0));
}

function truncateToDecimals(num, dec = 2) {
	const calcDec = Math.pow(10, dec);

	var bignum = new Big(num);
	var multiplied = parseInt(bignum.times(calcDec));
	var newbig = new Big(multiplied);
	var returnval = newbig.div(calcDec);

	return returnval.toFixed(dec);
}

function error_handle(error, caller = 'unknown', severity = 'error') {

	var scriptname = 'QSLPParser.js';

	console.log("Error Handle has been called!");

	console.log(error);

	let transporter = nodemailer.createTransport({
		sendmail: true,
		newline: 'unix',
		path: '/usr/sbin/sendmail'
	});
	transporter.sendMail({
		from: iniconfig.error_from_email,
		to: iniconfig.error_to_email,
		subject: 'OhNo! Error in ' + scriptname + ' at ' + caller,
		text: 'OhNo! Error in ' + scriptname + ' at ' + caller + '\n\n' + JSON.stringify(error)
	}, (err, info) => {
		console.log(err);
		console.log(info);
	});

}

