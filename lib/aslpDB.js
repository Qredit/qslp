/*
*
* ASLP - Version 2.0.0
*
* Ark Side Ledger Protocol
*
* A simplified token management system for the Ark network
*
* ASLPDB
*
*/


/*
* MongoDB Functions
*/

const MongoClient = require('mongodb').MongoClient;
const autoIncrement = require("mongodb-autoincrement");
const assert = require('assert');
const Big = require('big.js');
//const crypto				= require('crypto');
const SparkMD5 = require('spark-md5');  // Faster than crypto
const _ = require('underscore-node');

var aslpDB = /** @class */ (function () {

	var connectionString;
	var dbName;
	var db;
	var client;

	function aslpDB(connectionString, dbName) {
		if (connectionString === void 0)
			this.connectionString = 'mongodb://localhost:27017';
		else
			this.connectionString = connectionString;

		if (dbName === void 0)
			this.dbName = 'arkslp';
		else
			this.dbName = dbName;

		return this;

	}

	aslpDB.prototype.connect = function () {

		var connectionString = this.connectionString;
		var dbName = this.dbName;

		return new Promise((resolve, reject) => {

			MongoClient.connect(connectionString, { useNewUrlParser: true, useUnifiedTopology: true }, function (error, client) {

				if (error) {
					reject(error); return;
				}

				//console.log("Connected Correctly to MongoDB Server - Database: " + dbName);

				resolve(client);

			});

		});

	}

	aslpDB.prototype.setClient = function (client) {

		this.client = client;
		this.db = client.db(this.dbName);
		return true;

	};

	aslpDB.prototype.ping = function () {

		return new Promise((resolve, reject) => {

			this.db.command({ ping: 1 }, function (error, reply) {
				if (error) {
					reject(error); return;
				}
				resolve(reply);
			});

		});

	};

	aslpDB.prototype.close = function (client) {

		return this.client.close();

	};

	/* Just a testing function */
	aslpDB.prototype.getConnectionString = function () {

		return this.connectionString;

	};

	aslpDB.prototype.findDocument = function (collection, query) {

		return new Promise((resolve, reject) => {
			
			var collection = this.db.collection(collection);

			collection.findOne(query, { projection: { _id: 0 } }, function (error, docs) {

				if (error) {
					reject(error); return;
				}
				resolve(docs);

			});

		});

	}

	aslpDB.prototype.findDocuments = function (collection, query, limit = 100, sort = {}, skip = 0) {

		return new Promise((resolve, reject) => {
			
			var collection = this.db.collection(collection);

			collection.find(query, { projection: { _id: 0 }, limit: limit, sort: sort, skip: skip }).toArray(function (error, docs) {

				if (error) {
					reject(error); return;
				}
				resolve(docs);

			});

		});

	}

	aslpDB.prototype.findDocumentsWithId = function (collection, query, limit = 100, sort = {}, skip = 0) {

		return new Promise((resolve, reject) => {
			
			var collection = this.db.collection(collection);

			collection.find(query, { limit: limit, sort: sort, skip: skip }).toArray(function (error, docs) {

				if (error) {
					reject(error); return;
				}
				resolve(docs);

			});

		});

	}

	aslpDB.prototype.findDocumentCount = function (collection, query) {

		return new Promise((resolve, reject) => {
			
			var collection = this.db.collection(collection);

			collection.find(query, {}).count(function (error, count) {

				if (error) {
					reject(error); return;
				}
				resolve(count);

			});

		});

	}

	aslpDB.prototype.findDocumentBigSum = function (collection, query, sumfield) {

		return new Promise((resolve, reject) => {
			
			var collection = this.db.collection(collection);

			collection.find(query, {}).toArray(function (error, results) {

				if (error) {
					reject(error); return;
				}

				let sum = _.reduce(results, function (memo, thisdoc) {
					try {
						return new Big(memo).plus(eval("thisdoc." + sumfield)); // << TODO:	 This is kind of a NO NO - We shouldn't use eval
					} catch (e) {
						return new Big(memo);
					}

				}, 0);

				resolve(sum);

			});

		});

	}

	aslpDB.prototype.findDocumentHash = function (collection, query, field, sort) {

		return new Promise((resolve, reject) => {
			
			var collection = this.db.collection(collection);

			collection.find(query, { projection: { _id: 0 }, limit: 10, sort: sort, skip: 0 }).toArray(function (error, results) {

				if (error) {
					reject(error); return;
				}

				let fieldcat = _.reduce(results, function (memo, thisdoc) {

					return memo + '' + eval("thisdoc." + field); // << TODO:  This is kind of a NO NO - We shouldn't use eval

				}, 0);

				if (fieldcat) {
					//var hashcat = crypto.createHash('md5').update(fieldcat).digest('hex');
					var hashcat = SparkMD5.hash(fieldcat);
				}
				else {
					//var hashcat = crypto.createHash('md5').update('').digest('hex');
					var hashcat = SparkMD5.hash('');
				}

				resolve(hashcat);


			});

		});

	}

	aslpDB.prototype.insertDocument = function (collection, query) {
		
		return new Promise((resolve, reject) => {
			
			var collection = this.db.collection(collection);

			collection.insertOne(query, function (error, result) {

				if (error) {
					reject(error); return;
				}
				resolve(result);

			});

		});

	}

	aslpDB.prototype.insertDocuments = function (collection, query) {

		return new Promise((resolve, reject) => {
			
			var collection = this.db.collection(collection);

			collection.insertMany([query], function (error, result) {

				if (error) {
					reject(error); return;
				}
				resolve(result);

			});

		});

	}


	aslpDB.prototype.createJournalEntry = function (txid, blockId, blockHeight, timestamp, timestampUnix, action, collectionName, fieldData, recordData) {

		return new Promise((resolve, reject) => {
			
			var collection = this.db.collection('journal');

			autoIncrement.getNextSequence(this.db, 'journal', "_id", function (err, autoIndex) {

				delete fieldData['_id'];
				delete recordData['_id'];

				var recordHash = SparkMD5.hash(action + '' + JSON.stringify(fieldData) + '' + JSON.stringify(recordData));

				var insertData = {
					txid: txid,
					blockId: blockId,
					blockHeight: blockHeight,
					timestamp: timestamp,
					timestamp_unix: timestampUnix,
					action: action,
					collectionName: collectionName,
					fieldData: JSON.stringify(fieldData),
					recordData: JSON.stringify(recordData),
					recordHash: recordHash,
					chainHash: ''
				};

				if (autoIndex > 1) {
					var lastIndex = parseInt(Big(autoIndex).minus(1).toFixed(0));
				}
				else {
					var lastIndex = 0;
				}

				insertData._id = autoIndex;

				console.log('autoIndex: ' + autoIndex);

				collection.insertOne(insertData, function (error, result) {

					if (error) {
						console.log(error);
						reject(error); return;
					}

					if (autoIndex == 1) // This is the first entry
					{

						// chainHash = recordHash
						console.log('update after insert #1 - ' + recordHash);

						collection.updateOne({ "_id": autoIndex }, { $set: { "chainHash": recordHash } }, function (error, updateresult) {

							if (error) {
								console.log(error);
								reject(error); return;
							}
							resolve(updateresult);

						});

					}
					else {

						collection.findOne({ '_id': lastIndex }, {}, function (error, docs) {

							if (error) {
								console.log(error);
								reject(error); return;
							}

							console.log('lastRecordHash: ' + docs.recordHash);

							var chainHash = SparkMD5.hash(docs.recordHash + '' + recordHash);

							console.log('chainHash: ' + chainHash);

							collection.updateOne({ "_id": autoIndex }, { $set: { "chainHash": chainHash } }, function (error, result) {

								if (error) {
									console.log(error);
									reject(error); return;
								}
								resolve(result);

							});


						});

					}


				});

			});

		});

	}

	aslpDB.prototype.updateDocument = function (collection, findquery, setquery) {

		return new Promise((resolve, reject) => {
			
			var collection = this.db.collection(collection);

			collection.updateOne(findquery, { $set: setquery }, function (error, result) {

				if (error) {
					reject(error); return;
				}
				resolve(result);

			});

		});

	}

	aslpDB.prototype.removeDocument = function (collection, query) {

		return new Promise((resolve, reject) => {
			
			var collection = this.db.collection(collection);

			collection.deleteOne(query, function (error, result) {

				if (error) {
					reject(error);
					return;
				}
				resolve(result);

			});

		});

	}

	aslpDB.prototype.removeDocuments = function (collection, query) {

		return new Promise((resolve, reject) => {
			
			var collection = this.db.collection(collection);

			collection.deleteMany(query, function (error, result) {

				if (error) {
					reject(error);
					return;
				}
				resolve(result);

			});

		});

	}

	aslpDB.prototype.createIndex = function (collection, query, unique = true) {
		
		return new Promise((resolve, reject) => {
			
			var collection = this.db.collection(collection);

			if (unique == true) sparse = false;
			else sparse = true;

			collection.createIndex(query, { background: true, sparse: sparse, unique: unique }, function (error, result) {

				if (error) {
					reject(error);
					return;
				}
				resolve(result);

			});

		});

	}

	aslpDB.prototype.createCollection = function (collection, options = {}) {

		return new Promise((resolve, reject) => {
			
			var db = this.db;

			db.createCollection(collection, options, function (error, result) {

				if (error) {
					reject(error);
					return;
				}
				resolve(result);

			});

		});

	}

	aslpDB.prototype.doesCollectionExist = function (collection) {

		return new Promise((resolve, reject) => {
			
			var db = this.db;

			db.listCollections().toArray(function (err, items) {

				if (err) {
					reject(err);
					return;
				}

				if (items.length == 0) {
					resolve(false);
					return;
				}

				for (var i = 0; i < items.length; i++) {
					if (items[i].name == collection) {
						resolve(true);
						return;
					}
				}

				resolve(false);

			});

		});

	}

	return aslpDB;

}());

exports.default = aslpDB;
