import PouchDB from 'pouchdb';
import ReplicationStream from 'pouchdb-replication-stream';

import {promises as fs, constants as fsConstants, createReadStream, createWriteStream} from 'fs';
import path from 'path';

import ConfigBase from '../configBase.js';

// pouchdb-replication-stream allows us to "seed" the database with an initial database dump
//  incredibly useful for the wdw db, which is pretty huge
PouchDB.plugin(ReplicationStream.plugin);
PouchDB.adapter('writableStream', ReplicationStream.adapters.writableStream);

/**
 * Promise-based delay helper function
 * @param {number} time Milliseconds to wait before resolving Promise
 */
async function delay(time) {
  return new Promise((resolve) => {
    setTimeout(resolve, time);
  });
}

/**
 * Live Database object for Disney parks using couchbase databases
 * Will syncronise databae locally before accessing, allowing fast queries
 * @class
 */
export default class DisneyLiveDB extends ConfigBase {
  /**
     * Create a new DisneyLiveDB object
     * @param {*} options
     */
  constructor(options = {}) {
    if (!options.dbName) {
      options.dbName = 'wdw';
    }

    // env variables can override with
    //  env.WDWDB_HOST, env.WDWDB_USERNAME, env.WDWDB_PASSWORD etc.
    if (!options.configPrefixes) {
      options.configPrefixes = ['wdwdb'];
    }

    options.host = options.host || '';
    options.username = options.username || '';
    options.password = options.password || '';
    // TODO - get latest useragent for app
    options.useragent = options.useragent || 'CouchbaseLite/1.3 (1.4.1/8a21c5927a273a038fb3b66ec29c86425e871b11)';

    // how often to take database checkpoints (default 15 minutes)
    options.checkpointTime = options.checkpointTime || 1000 * 60 * 15;

    super(options);

    // create our database objects
    this.localDB = new PouchDB(`localdb/${this.config.dbName}`);
    this.remoteDB = new PouchDB(this.config.host, {
      auth: {
        username: this.config.username,
        password: this.config.password,
      },
      // override user-agent header when syncing remote database
      fetch: (url, opts) => {
        opts.headers.set('User-Agent', this.config.useragent);
        return PouchDB.fetch(url, opts);
      },
    });

    this.synced = false;

    this.initPromiseSync = null;

    // start the database disk scheduler
    this._scheduleDBDump();
  }

  /**
   * Initialise the live database, returns once finished an initial sync
   */
  async init() {
    if (this.synced) {
      return;
    }

    if (this.initPromiseSync) return this.initPromiseSync;

    // first, syncronise our database before we start rolling updates
    this.initPromiseSync = this._loadAndInit();
    // keep the Promise as a variable so we can keep returning it for any additional init() calls
    await this.initPromiseSync;
    this.initPromiseSync = null;

    console.log(`Database ${this.config.dbName} finished setup!`);

    this.synced = true;

    // start rolling replicate to keep our local database in-sync
    PouchDB.replicate(this.remoteDB, this.localDB, {
      live: true,
      retry: true,
    }).on('change', (info) => {
      console.log(info.docs);
    });
  }

  /**
   * @private
   * Internal function
   * Loads and performs an initial sync on the database
   */
  async _loadAndInit() {
    // first, try and restore from disk
    await this.load();

    // then perform an initial replication from remote to local
    console.log('Performing initial replication...');
    await PouchDB.replicate(this.remoteDB, this.localDB, {
      batch_size: 500,
    });

    // then dump our initial state to disk
    return await this.dump();
  }

  /**
   * Get the filename we use for saving backups of the database to disk
   * Used for creating simple "snapshots" to reduce initial sync times
   * @param {string} [postfix] Optional postfix for the filename
   * @return{string}
   */
  getDumpFilename(postfix='') {
    return path.join('localdb', `${this.config.dbName}${postfix}.db`);
  }

  /**
   * Restore a database backup from disk
   * Perform this after running "dump()" on a previous synced database
   * This will help to reduce the initial sync time for large databases
   */
  async load() {
    const dumpPath = this.getDumpFilename();

    // if our database dump doesn't exist, then early out and we'll do a normal sync
    try {
      await fs.access(dumpPath, fsConstants.F_OK);
    } catch (error) {
      return;
    }

    console.log('Restoring database from disk...');

    // otherwise, load up our database from disk
    const ws = createReadStream(dumpPath);
    return this.localDB.load(ws, {
      batch_size: 500,
    });
  }

  /**
   * Dump this live database to disk
   * This will be used to "seed" the database to speed up syncs for future runs
   */
  async dump() {
    if (this.databaseDumpPendingPromise) {
      return this.databaseDumpPendingPromise;
    }

    console.log('Dumping database to disk...');

    const dumpPath = this.getDumpFilename();
    const dumpPathNew = this.getDumpFilename('_new');

    // dump database to our new location
    const ws = createWriteStream(dumpPathNew);
    this.databaseDumpPendingPromise = this.localDB.dump(ws, {
      batch_size: 500,
    });
    // save Promise so multiple "dump()" calls can stack cleanly
    await this.databaseDumpPendingPromise;
    this.databaseDumpPendingPromise = null;

    // rename new database dump to our final intended location
    return fs.rename(dumpPathNew, dumpPath);
  }

  /**
   * @private
   * Begin a database dump loop
   * This will dump the database to disk every 15 minutes (override with options.checkpointTime)
   *  to speed up initial syncs
   */
  async _scheduleDBDump() {
    await delay(this.config.checkpointTime);

    // make sure database is initialised before writing anything to disk
    await this.init();
    await this.dump();

    process.nextTick(this._scheduleDBDump.bind(this));
  }

  /**
   * Get a document from this live database
   * Will wait until database is syncronised before returning
   * See PouchDB.get(...) for options
   */
  async get(...args) {
    await this.init();
    return await this.localDB.get.apply(this, args);
  }
}