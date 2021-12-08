/*
*
* ASLP - Version 2.0.0
*
* Ark Side Ledger Protocol
*
* A simplified token management system for the Ark network
*
* ASLPParser - Parse the blockchain for ASLP items
*
*/

const redis = require('redis');			 // a really fast nosql keystore
const fs = require('fs');				 // so we can read the config ini file from disk
const ini = require('ini');				 // so we can parse the ini files properties
const Big = require('big.js');			 // required unless you want floating point math issues
const nodemailer = require('nodemailer');		 // for sending error reports about this node
const crypto = require('crypto');			 // for creating hashes of things
const SparkMD5 = require('spark-md5');  		 // Faster than crypto for md5
const asyncv3 = require('async');			 // Async Helper
const { Client } = require('pg');				 // Postgres
const { Transactions: ArkTransactions, Managers: ArkManagers, Utils: ArkUtils, Identities: ArkIdentities } = require("arkcrypto");

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

var iniconfig = ini.parse(fs.readFileSync('aslp.ini', 'utf-8'))

// Mongo Connection Details
const mongoconnecturl = iniconfig.mongo_connection_string;
const mongodatabase = iniconfig.mongo_database;

// MongoDB Library
const ASLPDB = require("./lib/aslpDB");
const qdb = new ASLPDB.default(mongoconnecturl, mongodatabase);


// ASLP-1 Token Schema
const ASLPSchema = require("./lib/aslpSchema");
const aslp = new ASLPSchema.default();

// Declaring some variable defaults

const ASLPactivationHeight = 17891337;
const ASLPactivationBlockId = '59a86d78b369c3cbc914101d4f940ad2004d6b1c4e716dc9e67004311b3a07a3';

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

var rclient;
var rclienttwo;

dorun();

function dorun()
{
	
	(async () => {

		// Connect to Redis and setup some async call definitions
		// Primary redis connection for get, set, del
		rclient = redis.createClient(iniconfig.redis_port, iniconfig.redis_host, { detect_buffers: true });
		// Subscription redis connection
		rclienttwo = rclient.duplicate();

		// Let us know when we connect or have an error with redis
		rclient.on('connect', () => console.log('Connected to Redis'));
		rclient.on('error', (err) => console.log('Redis Client Error', err));

		await rclient.connect();
		await rclienttwo.connect();
	
		var lbreply = await rclient.get('ASLP_lastscanblock');
	
		var ignorerunparams = await rclient.get('ASLP_ignorerunparameters');

		// Resync/Rescan Flag or Unknown last scan -  rescans all transaction (ie. #node aslpParser.js resync)

		if ((ignorerunparams == null && process.argv.length == 3 && process.argv[2] == 'resync') || lbreply == null) {

			console.log("--------------------");
			console.log("Forcing a Rescan....");
			console.log("--------------------");
			
			await rclient.set('ASLP_lastscanblock', Big(ASLPactivationHeight).toFixed(0));
			await rclient.set('ASLP_lastblockid', ASLPactivationBlockId);

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
				await qdb.insertDocument('counters', {collection: 'journal', field: 'id', current: 0});
			}

			await aslp.indexDatabase(qdb);
	
			await qdb.close();

			// Initialze things
			initialize();

		}
		else if (ignorerunparams == null && process.argv.length == 4 && process.argv[2] == 'rollback') {

			/* Roll back to specified blockheight and resume from there:   node aslpParser.js rollback 122343 */

			var rollbackHeight = parseInt(process.argv[3]);

			var mclient = await qdb.connect();
			qdb.setClient(mclient);

			console.log("Performing Rollback to Block Height: " + rollbackHeight);

			await rebuildDbFromJournal(rollbackHeight, qdb);

			initialize();

		}
		else {
			await rclient.del('ASLP_ignorerunparameters');
			// These aren't the droids we are looking for, move along...  
			initialize();
		}
	
	})();

}

// Main Functions
// ==========================

function initialize() {

	downloadChain();
	blockNotifyQueue();

}

function blockNotifyQueue() {

	(async () => {
		
		var data = await rclienttwo.blPop('blockNotify', iniconfig.polling_interval);

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

	})();
	
}

function downloadChain() {

	scanLock = true;
	scanLockTimer = Math.floor(new Date() / 1000);

	(async () => {

		var doresync = await rclient.get('ASLP_resyncfromjournalheight');

		if (doresync != null) {

			// out of sync with peers...

			var mclient = await qdb.connect();
			qdb.setClient(mclient);

			await rebuildDbFromJournal(parseInt(doresync), qdb);

			await rclient.del('ASLP_resyncfromjournalheight');

			await qdb.close();

		}
		else {

			var pgclient = new Client({ user: iniconfig.pg_username, database: iniconfig.pg_database, password: iniconfig.pg_password });
			await pgclient.connect()
			var message = await pgclient.query('SELECT * FROM blocks ORDER BY height DESC LIMIT 1')
			await pgclient.end()


			var topHeight = 0;
			if (message && message.rows && message.rows[0].height) {
				var topHeight = message.rows[0].height;
				lastBlockId = message.rows[0].id;
			}

			console.log('Current Block Height: #' + topHeight + '.....');

		}

		scanLock = false;
		scanLockTimer = 0;

		doScan();

	})();

}

function syncJournalFromPeer() {

	// TODO



}

function rebuildDbFromJournal(journalHeight, qdb) {

	return new Promise((resolve) => {

		(async () => {

			journalHeight = parseInt(journalHeight);

			var startTime = (new Date()).getTime();

			try {

				// Remove Journal Entries above the rollback	
				await qdb.removeDocuments('journal', { "blockHeight": { $gte: journalHeight } });

				// Remove all tokens
				await qdb.removeDocuments('tokens', {});

				// Remove all addresses
				await qdb.removeDocuments('addresses', {});

				// Remove all transactions
				await qdb.removeDocuments('transactions', {});

				// Remove all metadata
				await qdb.removeDocuments('metadata', {});

				// Remove all counters
				await qdb.removeDocuments('counters', {});
				await qdb.insertDocument('counters', {collection: 'journal', field: 'id', current: 0});
				
				// Get last journal entry after pruning			
				var findLastJournal = await qdb.findDocumentsWithId('journal', {}, 1, { "_id": -1 }, 0);

				var lastJournalEntry = findLastJournal[0];
				
				if (!lastJournalEntry) {
					
					// Something Broke.  Start over....

					await rclient.del('ASLP_lastblockid');
					await rclient.del('ASLP_lastscanblock');
					
					await rclient.set('ASLP_ignorerunparameters', '1');
					process.exit(-1);

				}
				else {

					var lastJournalID = lastJournalEntry['_id'];
					var lastJournalBlockId = lastJournalEntry['blockId'];
					var lastJournalBlockHeight = lastJournalEntry['blockHeight'];

					await rclient.set('ASLP_lastscanblock', Big(lastJournalBlockHeight).toFixed(0));
					await rclient.set('ASLP_lastblockid', lastJournalBlockId);
					
					console.log('ROLLBACK TO: ' + lastJournalID + ":" + lastJournalBlockHeight + ":" + lastJournalBlockId);

					// Update Counters to new top Journal
					await qdb.updateDocument('counters', { "collection": "journal", "field": "id" }, { "current": lastJournalID });

					// Rebuild DB via Journal

					var jLimit = 1000;
					var jStart = 0;
					var jContinue = 1;

					while (jContinue == 1) {

						var getJournals = await qdb.findDocumentsWithId('journal', {}, jLimit, { "_id": 1 }, jStart);

						console.log('Rebuilding ' + getJournals.length + ' Journal Entries....');

						jStart = jStart + jLimit;

						for (ji = 0; ji < getJournals.length; ji++) {

							var journalItem = getJournals[ji];

							var journalAction = journalItem['action'];
							var journalCollection = journalItem['collectionName'];
							var journalField = JSON.parse(journalItem['fieldData']);
							var journalRecord = JSON.parse(journalItem['recordData']);

							if (journalAction == 'insert') {

								await qdb.insertDocument(journalCollection, journalRecord);

							}
							else if (journalAction == 'update') {

								await qdb.updateDocument(journalCollection, journalField, journalRecord);

							}
							else {
								console.log('UNKNOWN Journal Action - FATAL');

								await rclient.del('ASLP_lastblockid');
								await rclient.del('ASLP_lastscanblock');
								
								await rclient.set('ASLP_ignorerunparameters', '1');
								process.exit(-1);
							}
							
							lastJournalID = journalItem['_id'];
							lastJournalBlockId = journalItem['blockId'];
							lastJournalBlockHeight = journalItem['blockHeight'];
						
						}
						
						if (getJournals.length < jLimit) jContinue = 0;

					}

					await rclient.set('ASLP_lastscanblock', Big(lastJournalBlockHeight).toFixed(0));
					await rclient.set('ASLP_lastblockid', lastJournalBlockId);
					await qdb.updateDocument('counters', { "collection": "journal", "field": "id" }, { "current": parseInt(lastJournalID) });

					console.log('Journal Rebuild Completed..');
					console.log("lastJournalId: " + lastJournalID);
					console.log("lastJournalBlockId: " + lastJournalBlockId);
					console.log("lastJournalBlockHeight: " + lastJournalBlockHeight);
	
				}

			} catch (e) {

				console.log('Error During Rollback - FATAL');
				console.log(e);
				console.log("Last Journal Entry:");
				console.log(lastJournalEntry);

				await rclient.del('ASLP_lastblockid');
				await rclient.del('ASLP_lastscanblock');
						
				await rclient.set('ASLP_ignorerunparameters', '1');
				process.exit(-1);
			}

			var endTime = (new Date()).getTime();

			var elapsedTime = (endTime - startTime) / 1000;

			console.log('Rollback completed in ' + elapsedTime + ' seconds');
			
			resolve(true);

		})();

	});

}

function doScan() {

	(async () => {
		
		scanLock = true;
		scanLockTimer = Math.floor(new Date() / 1000);

		var reply = await rclient.get('ASLP_lastscanblock');

		if (reply == null) {
			scanBlockId = ASLPactivationHeight;
		}
		else {
			scanBlockId = parseInt(reply);
		}

		//

		var replytwo = await rclient.get('ASLP_lastblockid');

		if (reply == null) {
			lastBlockId = '';
		}
		else {
			lastBlockId = replytwo;
		}

		//

		console.log('Scanning from Height: #' + scanBlockId + '.....');

		var currentHeight = 0;

		var pgclient = new Client({ user: iniconfig.pg_username, database: iniconfig.pg_database, password: iniconfig.pg_password });
		await pgclient.connect()
		var message = await pgclient.query('SELECT * FROM blocks ORDER BY height DESC LIMIT 1');

		if (message && message.rows) currentHeight = parseInt(message.rows[0].height);

		console.log('New ASLP Block Height: #' + currentHeight);

		var mclient = await qdb.connect();
		qdb.setClient(mclient);

		await whilstScanBlocks(scanBlockId, currentHeight, pgclient, qdb);
		
	})();

}


async function whilstScanBlocks(count, max, pgclient, qdb) {

	return new Promise((resolve) => {

		asyncv3.whilst(
			function test(cb) { cb(null, count < max) },
			function iter(callback) {

				(async () => {
					
					if (shuttingdown == true) {

						safetoshutdown = true;

					}
					else {

						count++;

						scanLockTimer = Math.floor(new Date() / 1000);

						if (count % 1000 == 0 || count == max) console.log("Next scan from Height: #" + count);

						var message = await pgclient.query('SELECT id, number_of_transactions, height, previous_block FROM blocks WHERE height = $1 LIMIT 1', [count]);
					
						if (message && message.rows) {

							var blockdata = message.rows[0];

							if (blockdata && blockdata.id) {

								var blockidcode = blockdata.id;
								var blocktranscount = blockdata.number_of_transactions;
								var thisblockheight = blockdata.height;

								var previousblockid = blockdata.previous_block;

								if (lastBlockId != previousblockid && thisblockheight > 1) {

									// New code attempts a rollback


									var rollbackHeight = thisblockheight - 5;
									if (rollbackHeight < 0) {

										console.log('Error:	 Last Block ID is incorrect!  Rescan Required!');

										console.log("Expected: " + previousblockid);
										console.log("Received: " + lastBlockId);
										console.log("ThisBlockHeight: " + thisblockheight);
										console.log("LastScanBlock: " + count);

										await rclient.del('ASLP_lastblockid');
										await rclient.del('ASLP_lastscanblock');
											
										await rclient.set('ASLP_ignorerunparameters', '1');
										process.exit(-1);

									}
									else {

										console.log('Error:	 Last Block ID is incorrect!  Attempting to rollback 5 blocks!');

										await rebuildDbFromJournal(rollbackHeight, qdb);

										await rclient.set('ASLP_ignorerunparameters', '1');
										process.exit(-1);

									}
						

								}
								else {

									lastBlockId = blockidcode;

									processedItems = false;

									if (parseInt(blocktranscount) > 0 && thisblockheight >= ASLPactivationHeight) {

										var tresponse = await pgclient.query('SELECT * FROM transactions WHERE block_id = $1 ORDER BY sequence ASC', [blockidcode]);

										if (tresponse && tresponse.rows) {

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
												//txdata.sender = arkjs.crypto.getAddress(origtxdata.sender_public_key);
												txdata.sender = ArkIdentities.Address.fromPublicKey(origtxdata.sender_public_key);
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

														if (parsejson.aslp1) {

															console.log(txdata);

															var txmessage = await qdb.findDocuments('transactions', { "txid": txdata.id });
															if (txmessage.length == 0) {
																try {
																	var ASLPresult = await aslp.parseTransaction(txdata, blockdata, qdb);
																} catch (e) {
																	error_handle(e, 'parseTransaction', 'error');
																}
																processedItems = true;
															}
															else {
																console.log('ERROR:	 We already have TXID: ' + txdata.id);
															}

														}
														else if (parsejson.aslp2) {

															console.log(txdata);

															var txmessage = await qdb.findDocuments('metadata', { "txid": txdata.id });
															if (txmessage.length == 0) {
																try {
																	var ASLPresult = await aslp.parseTransaction(txdata, blockdata, qdb);
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

											await rclient.set('ASLP_lastscanblock', Big(thisblockheight).toFixed(0));
											await rclient.set('ASLP_lastblockid', blockidcode);

											callback(null, count);
;

										}
										else {
											// This needs to be handled.  TODO:	 Missing transactions when there should be some
											callback(null, count);
										}

								

									}
									else {

										// No longer use

										await rclient.set('ASLP_lastscanblock', Big(thisblockheight).toFixed(0));
										await rclient.set('ASLP_lastblockid', blockidcode);

										try {
											callback(null, count);
										} catch (e) {
											console.log(e);
										}


									}

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

					}

				})();
				
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

	console.log('Found New Blocks............');

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

	var scriptname = 'ASLPParser.js';

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

