import redis from 'redis';
import fs from 'fs';
import path from 'path';
import JSONStream from 'JSONStream';
import Writer from './Streamables';
import bluebird from 'bluebird';
import createPrefixModel from './model/Prefix';

bluebird.promisifyAll(redis.RedisClient.prototype);
bluebird.promisifyAll(redis.Multi.prototype);

import Settings from '../../../setting.json';

const validateInputIsArray = (input, funcName) => {
  if (!Array.isArray(input)) {
    throw new TypeError(`The argument to ${funcName} must be an array`);
  }
};

class SearchCache {
  constructor() {
    const opts = SearchCache.parseOpts();

    this.redisUrl = opts.redisUrl;
    this.client; // for redis client
    this.maxMemory = opts.maxMemory;
    this.suggestionCount = opts.suggestionCount;
    this.prefixMinChars = opts.prefixMinChars;
    this.prefixMaxChars = opts.prefixMaxChars;
    this.completionMaxChars = opts.completionMaxChars;
    this.bucketLimit = opts.bucketLimit;
  }

  static defaultOpts() {
    return {
      redisUrl: process.env.REDIS_URL,
      maxMemory: 500,
      suggestionCount: 5,
      prefixMinChars: 1,
      prefixMaxChars: 15,
      completionMaxChars: 50,
      bucketLimit: 50,
    };
  }

  static parseOpts() {
    return { ...this.defaultOpts(), ...Settings };
  }

  async setClients() {
    // don't create new client if not testing and client already exists
    if (this.client) {
      return;
    }

    const redisOptions = {
      url: this.redisUrl,
      retry_strategy: function(options) {
        if (options.error && options.error.code === 'ECONNREFUSED') {
          // End reconnecting on a specific error and flush all commands with
          // a individual error
          return new Error('The server refused the connection');
        }
        if (options.total_retry_time > 1000 * 60 * 60) {
          // End reconnecting after a specific timeout and flush all commands
          // with a individual error
          return new Error('Retry time exhausted');
        }
        if (options.attempt > 10) {
          // End reconnecting with built in error
          return undefined;
        }
        // reconnect after
        return Math.min(options.attempt * 100, 3000);
      },
    };

    this.client = redis.createClient(redisOptions);
  }

  quitRedisClient() {
    this.client.quit();
  }

  normalizePrefix(string) {
    string = string.slice(0, this.prefixMaxChars);
    string = string.toLowerCase();
    string = string.replace(/\s{2,}/g, ' '); // remove instances of more than one whitespace
    return string;
  }

  normalizeCompletion(string) {
    string = string.slice(0, this.completionMaxChars);
    string = string.toLowerCase();
    string = string.trim();
    string = string.replace(/\s{2,}/g, ' '); // remove instances of more than one whitespace
    return string;
  }

  extractPrefixes(completion) {
    completion = this.normalizePrefix(completion);

    const start = this.prefixMinChars;
    const prefixes = [];
    for (let i = start; i <= completion.length; i++) {
      prefixes.push(completion.slice(0, i));
    }
    return prefixes;
  }

  addTenant(prefix, tenant) {
    return tenant + ':' + prefix;
  }

  importFile(filePath, tenant) {
    const json = fs.createReadStream(
      path.resolve(process.cwd(), filePath),
      'utf8'
    );
    const parser = JSONStream.parse('*');
    const writer = new Writer(this, tenant);

    const promise = new Promise((resolve, reject) => {
      json.pipe(parser).pipe(writer);
      writer.on('finish', () => resolve('Import finished'));
    });
    return promise;
  }

  async mongoFind(prefix, token) {
    const prefixModel = createPrefixModel(token);
    const singleModel = await prefixModel.findOne({ prefix });
    return singleModel && singleModel.completions
      ? singleModel.completions
      : [];
  }

  async mongoLoad(prefix, token) {
    const commands = [];
    const completions = await this.mongoFind(prefix, token);
    const prefixWithTenant = this.addTenant(prefix, token);

    for (var i = 0; i < completions.length; i += 2) {
      commands.push([
        'zadd',
        prefixWithTenant,
        completions[i + 1],
        completions[i],
      ]);
    }

    return this.client.batch(commands).execAsync();
  }

  async mongoPersist(prefix, token) {
    const prefixWithTenant = this.addTenant(prefix, token);
    const completions = await this.client.zrangeAsync(
      prefixWithTenant,
      0,
      -1,
      'WITHSCORES'
    );

    const prefixModel = createPrefixModel(token);
    if (completions.length === 0) {
      await prefixModel.findOneAndDelete({ prefix });
    } else {
      await prefixModel.createIndexes({ prefix: 'text', background: true });
      await prefixModel.findOneAndUpdate(
        { prefix },
        { $set: { completions } },
        { new: true, upsert: true }
      );
    }
  }

  async persistPrefixes(prefixes, tenant) {
    for (var i = 0; i < prefixes.length; i++) {
      await this.mongoPersist(prefixes[i], tenant);
    }
  }

  async getCompletionsCount(prefix, tenant, prefixWithTenant) {
    let count = await this.client.zcountAsync(prefixWithTenant, '-inf', '+inf');

    if (count === 0) {
      await this.mongoLoad(prefix, tenant);
      count = await this.client.zcountAsync(prefixWithTenant, '-inf', '+inf');
    }

    return count;
  }

  async insertCompletion(prefixes, tenant, completion) {
    for (let i = 0; i < prefixes.length; i++) {
      let prefixWithTenant = this.addTenant(prefixes[i], tenant);
      const count = await this.getCompletionsCount(
        prefixes[i],
        tenant,
        prefixWithTenant
      );

      if (count < this.bucketLimit) {
        await this.client.zaddAsync(prefixWithTenant, 'NX', 0, completion);
      }
    }
  }

  async insertCompletions(array, tenant) {
    await this.setClients();
    validateInputIsArray(array, 'insertCompletions');

    let allPrefixes = [];

    for (let i = 0; i < array.length; i++) {
      let completion = array[i];
      completion = this.normalizeCompletion(completion);
      const prefixes = this.extractPrefixes(completion);

      allPrefixes = [...allPrefixes, ...prefixes];
      await this.insertCompletion(prefixes, tenant, completion);
    }

    return this.persistPrefixes(allPrefixes, tenant);
  }

  async deleteCompletions(completions, tenant) {
    validateInputIsArray(completions, 'deleteCompletions');

    let allPrefixes = [];
    const commands = [];
    completions.forEach(completion => {
      completion = this.normalizeCompletion(completion);
      const prefixes = this.extractPrefixes(completion);
      allPrefixes = [...allPrefixes, ...prefixes];

      prefixes.forEach(prefix => {
        const prefixWithTenant = this.addTenant(prefix, tenant);
        commands.push(['zrem', prefixWithTenant, completion]);
      }, this);
    });

    return this.client
      .batch(commands)
      .execAsync()
      .then(async () => {
        await this.persistPrefixes(allPrefixes, tenant);
        return 'persist success';
      });
  }

  async search(prefixQuery, tenant, opts = {}) {
    await this.setClients();

    const defaultOpts = { limit: this.suggestionCount, withScores: false };
    opts = { ...defaultOpts, ...opts };
    const limit = opts.limit - 1;
    const prefix = this.normalizePrefix(prefixQuery);
    const prefixWithTenant = this.addTenant(prefix, tenant);

    let args = [prefixWithTenant, 0, limit];
    if (opts.withScores) args = args.concat('WITHSCORES');

    let result = await this.client.zrangeAsync(...args);

    if (result.length === 0) {
      await this.mongoLoad(prefix, tenant);
      result = await this.client.zrangeAsync(...args);
    }

    return result;
  }

  async increment(completion, tenant) {
    completion = this.normalizeCompletion(completion);
    const prefixes = this.extractPrefixes(completion);
    const commands = [];
    const limit = this.bucketLimit;

    for (let i = 0; i < prefixes.length; i++) {
      let prefixWithTenant = this.addTenant(prefixes[i], tenant);
      let count = await this.getCompletionsCount(
        prefixes[i],
        tenant,
        prefixWithTenant
      );
      const includesCompletion = await this.client.zscoreAsync(
        prefixWithTenant,
        completion
      );

      if (count >= limit && includesCompletion < 0) {
        // Replace lowest score completion with the current completion, using the lowest score incremented by 1
        const lastPosition = limit - 1;
        const lastElement = await this.client.zrangeAsync(
          prefixWithTenant,
          lastPosition,
          lastPosition,
          'WITHSCORES'
        );
        const newScore = lastElement[1] - 1;
        commands.push(['zremrangebyrank', prefixWithTenant, lastPosition, -1]);
        commands.push(['zadd', prefixWithTenant, newScore, completion]);
      } else {
        commands.push(['zincrby', prefixWithTenant, -1, completion]);
      }
    }

    return this.client
      .batch(commands)
      .execAsync()
      .then(async () => {
        await this.persistPrefixes(prefixes, tenant);
        return 'persist success';
      });
  }
}

const searcher = new SearchCache();

export default searcher;
