"use strict";

var TopicManager = require("./kafka/TopicManager");
var Consumer = require("./kafka/Consumer");
var Producer = require("./kafka/Producer");
var defaultConfig = require("./config");
var uuid = require("uuid");
var util = require("util");
var logger = require("@dojot/dojot-module-logger").logger;
var auth = require("./auth");
var axios = require("axios");

const TAG = { filename: "messenger" };

/**
 * Class responsible for sending and receiving messages through Kafka using
 * dojot subjects and tenants.
 *
 * Using this class should be as easy as:
 *
 * ```javascript
 * var dojot = require(".");
 * var logger = require("@dojot/dojot-module-logger").logger;
 *
 * var config = dojot.Config;
 * var messenger = new dojot.Messenger("dojot-snoop", config);
 * messenger.init();
 *
 * // Create a channel using a default subject "device-data"
 * messenger.createChannel(config.dojot.subjects.deviceData, "rw");
 *
 * // Create a channel using a particular subject "service-status"
 * messenger.createChannel("service-status", "w");
 *
 * // Register callback to process incoming device data
 * messenger.on(config.dojot.subjects.deviceData, "message", (tenant, msg) => {
 *   logger.info(`Client: Received message in device data subject.`, TAG);
 *   logger.info(`Client: Tenant is: ${tenant}`, TAG);
 *   logger.info(`Client: Message is: ${msg}`, TAG);
 * });
 *
 * // Publish a message on "service-status" subject using "dojot-management" tenant
 * messenger.publish("service-status", config.management.tenant, "service X is up");
 *
 * ```
 * And that's all.
 *
 * You can use an internal event publishing/subscribing mechanism in order to
 * send events to other parts of the code (using ``messenger.on()`` and
 * ``messenger.emit()`` functions) without actually send or receive any
 * messages to/from Kafka. An example:
 *
 * ```javascript
 *    messenger.on("extra-subject", "subject-event", lambda tenant, data: print("Message received ({}): {}", (tenant, data)))
 *    messenger.emit("extra-subject", "management-tenant", "subject-event", "message data")
 * ```
 *
 * @property {TopicManager} topicManager Component for retrieving Kafka topics given a subject and a tenant
 * @property {Object} eventCallbacks A map associating subjects and events to callbacks.
 * @property {Array} tenants List of tenants detected so far
 * @property {Object} subjects Map associating subjects and modes ('r', 'w' or 'rw')
 * @property {Array} topics List of topics detected so far (associated to tenants and subjects)
 * @property {Object} producerTopics Map associating {tenants, subjects} to Kafka topics used for producing messages.
 * @property {Object} globalSubjects Map associating subjects to Kafka topics.
 * @property {Array} queuedMessages List of messages to be sent. This list will be populated before a producer is created.
 * @property {string} instanceId A unique ID for this library instance
 * @property {Config} config
 */
class Messenger {
  constructor(name, config) {
    this.topicManager = new TopicManager(config);
    this.eventCallbacks = {};
    this.tenants = [];
    this.subjects = {};
    this.topics = [];
    this.producerTopics = {};
    this.globalSubjects = {};
    this.queuedMessages = [];
    this.instanceId = name + '-' + uuid.v4();

    this.config = config || defaultConfig;

    // Creating consumer for tenant messages. This consumer belongs to a unique
    // group.
    const { kafka } = JSON.parse(JSON.stringify(this.config));

    kafka.producer["client.id"] = this.instanceId;
    logger.info(`Building new producer: ${util.inspect({kafka})}`, TAG);
    this.producer = new Producer({ kafka });

    // Removing "group.id" attribute and leaving the others.
    const { "group.id": userGroup, ...tenancyConfig} = kafka.consumer;
    kafka.consumer = tenancyConfig;
    tenancyConfig["group.id"] = `dojot-module-${uuid.v4()}`;
    this._tenancyConsumer = new Consumer({ kafka }, "tenancy consumer @ " + name);

    this.consumer = new Consumer(this.config, "normal consumer @ " + name);
  }

  /**
   * Initialize tenancy consumer.
   *
   * This consumer is a special one. It will get all tenant CRUD messages so
   * that it will be possible to subscribe to all other subjects that this
   * compponent has interest in.
   *
   * This function will properly initialize it (it is quite the same operations
   * as for "normal" subjects).
   */
  async _initTenancyConsumer() {
    return new Promise((resolve, reject) => {
      const subject = this.config.dojot.subjects.tenancy;
      const tenant = this.config.dojot.management.tenant;

      logger.debug(`Initializing tenancy consumer...`, TAG);
      this.globalSubjects[subject] = { mode: "r" };
      logger.debug(`Requesting topic for ${subject}@${tenant} to ${this.config.databroker.url}...`, TAG);
      this.topicManager.getTopic(subject, tenant, this.config.databroker.url, true).then((topic) => {

        logger.debug(`Got topic for subject ${subject} and tenant ${tenant}: ${topic}`, TAG);
        this.topics.push(topic);
        this._tenancyConsumer.subscribe(topic, (messages) => {
          this._processKafkaMessages(subject, tenant, messages);
        });
        logger.debug(`... topic for ${subject}@${tenant} was requested.`, TAG);

        logger.debug("Registering callback for tenancy consumer...", TAG);
        this.on(subject, "message", this._processNewTenant.bind(this));
        logger.debug("... callback registered for tenancy consumer.", TAG);
        resolve();
      }).catch((error) => {
          reject(`Could not reach Data Broker: ${error}.`);
      });
    });
  }

  /**
   * Initializes the messenger
   * @return a promise
   */
  async init() {
    let connectConsumerFn = (resolve, reject, client, counter) => {
      client.connect().then(() => {
        logger.info(`Kafka client connected`, TAG);
        resolve();
        return;
      }).catch((error) => {
        logger.warn(`Could not connect Kafka client: ${error}`, TAG);
        logger.warn(`Trying it again in ${this.config.kafka.dojot.timeoutSleep} seconds.`, TAG);
        counter--;
        logger.debug(`Remaining ${counter} times`, TAG);
        if (counter > 0) {
          setTimeout(() => {
            connectConsumerFn(resolve, reject, client, counter);
          }, this.config.kafka.dojot.timeoutSleep);
        } else {
          reject(`Could not connect Kafka consumer: ${error}`);
        }
      });
    };

    // Wait for all consumers to connect to Kafka brokers.
    const counter = this.config.kafka.dojot.connectionRetries;
    logger.debug("Connecting Kafka producer...", TAG);
    await new Promise((resolve, reject) => { connectConsumerFn(resolve, reject, this.producer, counter);});
    logger.debug("... Kafka producer successfully connected.", TAG);
    logger.debug("Connecting Kafka consumer for tenancy data...", TAG);
    await new Promise((resolve, reject) => { connectConsumerFn(resolve, reject, this._tenancyConsumer, counter); });
    logger.debug("... Kafka consumer for tenancy data successfully connected.", TAG);
    logger.debug("Connecting Kafka consumer for common messages...", TAG);
    await new Promise((resolve, reject) => { connectConsumerFn(resolve, reject, this.consumer, counter); });
    logger.debug("... Kafka consumer for common messages successfully connected.", TAG);
    await this._initTenancyConsumer();
    let tenants = await auth.getTenants(this.config.auth.url);
    logger.info(`Retrieved list of tenants: ${tenants}.`);
    for (const tenant of tenants) {
      logger.info(`Bootstrapping tenant ${tenant}...`, TAG);
      this._processNewTenant(this.config.dojot.management.tenant, JSON.stringify({ tenant }));
      logger.info(`... ${tenant} bootstrapped.`, TAG);
    }
    logger.info(`Finished tenant bootstrapping.`, TAG);
  }

  /**
   * Process a new tenant.
   * Whenever a new tenant is detected, it will request all the topics for
   * current active subjects.
   * @param {string} tenant Management tenant.
   * @param {string} msg The message describing the new tenant.
   */
  _processNewTenant(tenant, msg) {
    logger.debug(`Received message in tenancy subject.`, TAG);
    logger.debug(`Tenant is: ${tenant}`, TAG);
    logger.debug(`Message is: ${util.inspect(msg, {depth: null})}`, TAG);

    let data;
    try {
      data = JSON.parse(msg);
    } catch (error) {
      logger.warn("Data is not a valid JSON. Bailing out.", TAG);
      logger.warn(`Error is: ${error}`, TAG);
      return;
    }

    // Perform some sanity checks here
    if (!("tenant" in data)) {
      logger.warn("Received message is invalid. Bailing out.", TAG);
      return;
    }
    if (this.tenants.indexOf(data.tenant) != -1) {
      logger.warn("This tenant was already registered. Bailing out.", TAG);
      return;
    }

    this.tenants.push(data.tenant);
    for (let subject in this.subjects) {
      this._bootstrapTenant(subject, data.tenant, this.subjects[subject].mode);
    }
    this.emit(this.config.dojot.subjects.tenancy, this.config.dojot.management.tenant, "new-tenant", data.tenant);
  }

  /**
   * Emit a new message to all subscribers of a particular subject.
   * @param {string} subject The subject used to select which subscribers will be invoked.
   * @param {string} tenant The tenant associated to the emitted message.
   * @param {string} event The event associated to the emitted message.
   * @param {Object} data The message (or object)
   */
  emit(subject, tenant, event, data) {
    logger.debug(`Emitting new event ${event} for subject ${subject}@${tenant}`, TAG);
    // Sanity checks
    if (!(subject in this.eventCallbacks)) {
      logger.debug(`No one is listening to subject ${subject} events.`, TAG);
      return;
    }

    if (!(event in this.eventCallbacks[subject])) {
      logger.debug(`No one is listening to subject ${subject} ${event} events.`, TAG);
      return;
    }
    // Maybe we should use async.parallel or async.waterfall here?
    for (let callback of this.eventCallbacks[subject][event]) {
      callback(tenant, data);
    }

  }

  /**
   * Register a new callback to be invoked when something happens to a subject.
   * The callback must have the following signature:
   * - (tenant: string, data: string): void
   * @param {string} subject
   * @param {string} event
   * @param {function} callback
   */
  on(subject, event, callback) {
    logger.debug(`Registering new callback for subject ${subject} and event ${event}`, TAG);
    if (!(subject in this.eventCallbacks)) {
      this.eventCallbacks[subject] = {};
    }

    if (!(event in this.eventCallbacks[subject])) {
      this.eventCallbacks[subject][event] = [];
    }

    this.eventCallbacks[subject][event].push(callback);

    if (!(subject in this.subjects) && !(subject in this.globalSubjects)) {
      this.createChannel(subject);
    }
  }

  /**
   * Initialize a new subject using a particular tenant
   * @param {string} subject The subject to be initialized
   * @param {string} tenant The tenant
   * @param {string} mode 'r', 'w' or 'rw'
   * @param {string} isGlobal If this subject should be indenpendent from tenants.
   */
  _bootstrapTenant(subject, tenant, mode, isGlobal = false) {
    console.log(`Bootstraping tenant ${tenant} for subject ${subject}.`);
    console.log(`Global: ${isGlobal}, mode ${mode}`);
    let processKafkaMessagesCbk = (messages) => {
      this._processKafkaMessages(subject, tenant, messages);
    };

    logger.debug(`Requesting topic for ${subject}@${tenant}...`, TAG);
    this.topicManager.getTopic(subject, tenant, this.config.databroker.url, isGlobal).then((topic) => {
      if (this.topics.indexOf(topic) != -1) {
        logger.info(`already have a topic for ${subject}@${tenant}`, TAG);
        return;
      }
      logger.debug(`Got topic for subject ${subject} and tenant ${tenant}: ${topic}`, TAG);
      this.topics.push(topic);
      if (mode.indexOf('r') != -1) {
        this.consumer.subscribe(topic, processKafkaMessagesCbk);
      }

      if (mode.indexOf('w') != -1) {
        logger.debug("Adding a producer topic.", TAG);
        if (!(subject in this.producerTopics)) {
          this.producerTopics[subject] = {};
        }
        this.producerTopics[subject][tenant] = topic;
      }
    }).catch((error) => {
      logger.warn(`Could not get topic: ${error}`, TAG);
    });
    logger.debug(`... topic for ${subject}@${tenant} was requested.`, TAG);
  }

  /**
   * Creates a new channel, which is related to tenants, subjects and Kafka
   * topics.
   * @param {string} subject The subject to be associated to this channel.
   * @param {string} mode "r" for reading-only channels, "w" for writeable, and "rw" for both.
   * @param {boolean} isGlobal flag indicating whether this channel is sensitive to tenants.
   * (is it group by tenants, such as in "device-data" subject, or not, such as in "dojot.tenancy"?)
   */
  createChannel(subject, mode = "r", isGlobal = false) {
    logger.info(`Creating channel for subject ${subject}`, TAG);
    let associatedTenants = [];
    if (isGlobal === true) {
      associatedTenants = [this.config.dojot.management.tenant];
      this.globalSubjects[subject] = { mode };
    } else {
      associatedTenants = this.tenants;
      this.subjects[subject] = { mode };
    }

    for (let tenant of associatedTenants) {
      this._bootstrapTenant(subject, tenant, mode, isGlobal);
    }
  }

  _processKafkaMessages(subject, tenant, messages) {
      logger.debug(`Received message: ${util.inspect(messages, {depth: null})} `, TAG);
      this.emit(subject, tenant, "message", messages.value.toString("utf-8"));
  }

  publish(subject, tenant, message) {
    if (this.producer.isReady === false) {
      logger.debug("Producer is not yet ready. Queueing this message.", TAG);
      this.queuedMessages.push({subject, tenant, message});
      return;
    }
    logger.debug(`Trying to publish someting. Current producer topics are ${util.inspect(this.producerTopics, {depth: null})}`, TAG);
    if (!(subject in this.producerTopics)) {
      logger.warn(`No producer was created for subject ${subject}. Maybe it was not registered?`, TAG);
      logger.warn(`Message ${message} is being discarded!`, TAG);
      return;
    }
    if (!(tenant in this.producerTopics[subject])) {
      logger.warn(`No producer was created for subject ${subject}@${tenant}. Maybe this tenant doesn't exist?`, TAG);
      logger.warn(`Message ${message} is being discarded!`, TAG);
      return;
    }

    this.producer.produce(this.producerTopics[subject][tenant], message);
  }

  generateDeviceCreateEventForActiveDevices() {
    logger.debug('Requesting all active devices', TAG);
    let requestDevice = (tenant, pageNum) => {
      let extraArg = '';
      if (pageNum > 0) {
        extraArg = '?page_num=' + pageNum;
      }

      axios({
        url: this.config.deviceManager.url + "/device" + extraArg,
        method: "get",
        headers: {
          authorization: `Bearer ${auth.getManagementToken(tenant)}`,
        }
      }).then( (response) => {
        for (let device of response.data.devices) {
          let eventData = {
            event: "create",
            meta: {
              service: tenant
            },
            data: device
          };

          this.emit("iotagent.device", tenant, "device.create", eventData);
        }
        // take care of pagination
        if (response.data.pagination.has_next) {
          requestDevice(tenant, response.data.pagination.next_page);
        }
      }).catch ( (error) => {
        logger.error(error, TAG);
      });
    }

    for (let tenant of this.tenants) {
      requestDevice(tenant, 0);
    }
  }
}

module.exports = {Messenger};
