/*!
 * circuit-breaker
 * https://github.com/itkoren/circuit-breaker
 *
 * Copyright (c) 2014 Itai Koren (@itkoren) <itkoren@gmail.com>, contributors
 * Licensed under the MIT license.
 */
(function() {
    "use strict";

    // self will exist inside a WebWorker, otherwise, use this
    var root = "undefined" !== typeof self ? self : this;

    /*jshint validthis:true */
    var STATE = {
        OPEN: 0,
        HALF_OPEN: 1,
        CLOSED: 2
    };

    var MEASURE = {
        FAILURE: "failure",
        SUCCESS: "success",
        TIMEOUT: "timeout",
        OUTAGE: "outage"
    };

    /**
     * CircuitBreaker constructor
     * @param options - the configuration options for the instance {
     *      slidingTimeWindow: the time window that will be used for state calculations [milliseconds]
     *      bucketsNumber: the number of buckets that the time window will be split to (a bucket is a sliding unit that is added/remove from the time window)[number]
     *      tolerance: the allowed tolerance in percentage [percentage-number]
     *      calibration: the calibration that should be allowed (even if calls fails) before we start to update the state according to the tolerance and calculations (for avoiding first call that fails to be calculated as 100% failure) [number]
     *      timeout: optional timeout parameter to apply and time the command [number]
     * }
     */
    function CircuitBreaker(options) {
        // For forcing new keyword
        if (false === (this instanceof CircuitBreaker)) {
            return new CircuitBreaker(options);
        }

        this.initialize(options);
    }

    CircuitBreaker.prototype = (function () {
        /**
         * Method for initialization
         * @param options - the configuration options for the instance {
         *      slidingTimeWindow: the time window that will be used for state calculations [milliseconds]
         *      bucketsNumber: the number of buckets that the time window will be split to (a bucket is a sliding unit that is added/remove from the time window)[number]
         *      tolerance: the allowed tolerance in percentage [percentage-number]
         *      calibration: the calibration that should be allowed (even if calls fails) before we start to update the state according to the tolerance and calculations (for avoiding first call that fails to be calculated as 100% failure) [number]
         *      timeout: optional timeout parameter to apply and time the command [number]
         * }
         */
        function initialize(options) {
            if (!this.initialized) {
                options = options || {};

                this.slidingTimeWindow = !isNaN(options.slidingTimeWindow) && 0 < options.slidingTimeWindow ? parseInt(options.slidingTimeWindow, 10) : 30000;          // milliseconds
                this.bucketsNumber = !isNaN(options.bucketsNumber) && 0 < options.bucketsNumber ? parseInt(options.bucketsNumber, 10) : 10; // number
                this.tolerance = !isNaN(options.tolerance) && 0 < options.tolerance ? parseInt(options.tolerance, 10) : 50;                // percentage
                this.calibration = !isNaN(options.calibration) && 0 < options.calibration ? parseInt(options.calibration, 10) : 5;         // number
                this.timeout = !isNaN(options.timeout) && 0 < options.timeout ? parseInt(options.timeout, 10) : 0;                    // number

                this.onopen = ("function" === typeof options.onopen) ? options.onopen : function() {};
                this.onclose = ("function" === typeof options.onclose) ? options.onclose : function() {};

                this.buckets = [_createBucket.call(this)];
                this.state = STATE.CLOSED;

                this.initialized = true;

                _startTicking.call(this);
            }
        }

        /**
         * Method for assigning a defer execution
         * Code waiting for this promise uses this method
         * @param command - the command to run via the circuit
         * @param fallback - the fallback to run when circuit is opened
         * @param timeout - optional timeout for the command
         */
        function run(command, fallback, timeout) {
            if (isOpen.call(this)) {
                _fallback.call(this, fallback || function() {});
            }
            else {
                _execute.call(this, command, timeout);
            }
        }

        /**
         * Method for forcing the circuit to open
         */
        function open() {
            this.forced = this.state;
            this.state = STATE.OPEN;
        }

        /**
         * Method for forcing the circuit to close
         */
        function close() {
            this.forced = this.state;
            this.state = STATE.CLOSED;
        }

        /**
         * Method for resetting the forcing
         */
        function reset() {
            this.state = this.forced;
            this.forced = null;
        }

        /**
         * Method for checking whether the circuit is open
         */
        function isOpen() {
            return STATE.OPEN === this.state;
        }

        /**
         * Method for calculating the needed metrics based on all calculation buckets
         */
        function calculate() {
            var bucket;
            var errors;
            var totals;
            var percent;
            var total = 0;
            var error = 0;


            for (var i = 0, l = this.buckets.length; i < l; i++) {
                bucket = this.buckets[i];
                errors = (bucket[MEASURE.FAILURE] + bucket[MEASURE.TIMEOUT]);
                totals = errors + bucket[MEASURE.SUCCESS];

                error += errors;
                total += totals;
            }

            percent = (error / (total > 0 ? total : 1)) * 100;

            return {
                total: total,
                error: error,
                percent: percent
            };
        }

        /**
         * Method for the timer tick which manages the buckets
         */
        function _tick() {
            if (this.timer) {
                clearTimeout(this.timer);
            }

            _createNextSlidingBucket.call(this);

            if (this.bucketIndex > this.bucketsNumber) {
                this.bucketIndex = 0;

                if (isOpen.call(this)) {
                    this.state = STATE.HALF_OPEN;
                }
            }

            this.timer = setTimeout(_tick.bind(this), this.slide);
        }

        /**
         * Method for starting the timer and creating the metrics buckets for calculations
         */
        function _startTicking() {
            this.bucketIndex = 0;
            this.slide = this.slidingTimeWindow / this.bucketsNumber;

            if (this.timer) {
                clearTimeout(this.timer);
            }

            this.timer = setTimeout(_tick.bind(this), this.slide);
        }

        /**
         * Method for creating a single metrics bucket for calculations
         */
        function _createBucket() {
            var bucket = {};

            bucket[MEASURE.FAILURE] = 0;
            bucket[MEASURE.SUCCESS] = 0;
            bucket[MEASURE.TIMEOUT] = 0;
            bucket[MEASURE.OUTAGE] = 0;

            return bucket;
        }

        /**
         * Method for retrieving the last metrics bucket for calculations
         */
        function _getLastBucket() {
            return this.buckets[this.buckets.length - 1];
        }

        /**
         * Method for creating the next bucket and removing the first bucket in case we got to the needed buckets number
         */
        function _createNextSlidingBucket() {
            if (this.buckets.length > this.bucketsNumber) {
                this.buckets.shift();
            }

            this.bucketIndex++;

            this.buckets.push(_createBucket.call(this));

            if (this.buckets.length > this.bucketsNumber) {
                this.buckets.shift();
            }
        }

        /**
         * Method for adding a calculation measure for a command
         * @param prop - the measurement property (success, error, timeout)
         * @param status - the status of the command (A single command can only be resolved once and represent a single measurement)
         */
        function _measure(prop, status) {
            return function() {
                if (status.done) {
                    return;
                }
                else if (status.timeout) {
                    clearTimeout(status.timeout);
                    status.timeout = null;
                    delete status.timeout;
                }

                var bucket = _getLastBucket.call(this);
                bucket[prop]++;

                if (null === this.forced) {
                    _updateState.call(this);
                }

                status.done = true;
            }.bind(this);
        }

        /**
         * Method for executing a command via the circuit and counting the needed metrics
         * @param command - the command to run via the circuit
         * @param timeout - optional timeout for the command
         */
        function _execute(command, timeout) {
            var status = {
                done: false
            };
            var markSuccess = _measure.call(this, MEASURE.SUCCESS, status);
            var markFailure = _measure.call(this, MEASURE.FAILURE, status);
            var markTimeout = _measure.call(this, MEASURE.TIMEOUT, status);

            timeout = !isNaN(timeout) && 0 < timeout ? parseInt(timeout, 10) : this.timeout;

            if (0 < timeout) {
                status.timer = setTimeout(markTimeout, timeout);
            }

            try {
                command(markSuccess, markFailure, markTimeout);
            }
            catch(ex) {
                // TODO: Deal with errors
                markFailure();
            }
        }

        /**
         * Method for executing a command fallback via the circuit and counting the needed metrics
         * @param fallback - the command fallback to run via the circuit
         */
        function _fallback(fallback) {
            try {
                fallback();
            }
            catch(ex) {
                // TODO: Deal with errors
            }

            var bucket = _getLastBucket.call(this);
            bucket[MEASURE.OUTAGE]++;
        }

        /**
         * Method for updating the circuit state based on the last command or existing metrics
         */
        function _updateState() {
            var metrics = calculate.call(this);

            if (this.state == STATE.HALF_OPEN) {
                var lastCommandFailed = !_getLastBucket.call(this)[MEASURE.SUCCESS] && 0 < metrics.error;

                if (lastCommandFailed) {
                    this.state = STATE.OPEN;
                }
                else {
                    this.state = STATE.CLOSED;
                    this.onclose(metrics);
                }
            }
            else {
                var toleranceDeviation = metrics.percent > this.tolerance;
                var calibrationDeviation = metrics.total > this.calibration;
                var deviation = calibrationDeviation && toleranceDeviation;

                if (deviation) {
                    this.state = STATE.OPEN;
                    this.onopen(metrics);
                }
            }
        }

        return {
            initialize: initialize,
            run: run,
            close: close,
            open: open,
            reset: reset,
            isOpen: isOpen,
            calculate: calculate
        };
    }());

    /**
     * Public state enum
     */
    CircuitBreaker.STATE = STATE;

    /**
     * Method to polyfill bind native functionality in case it does not exist
     * Based on implementation from:
     * https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Function/bind
     * @param object - the object
     * @return {String} - the unique iFrame name
     */
    if (!Function.prototype.bind) {
        /*jshint validthis:true */
        Function.prototype.bind = function (object) {
            var args;
            var fn;

            if ("function" !== typeof this) {
                // Closest thing possible to the ECMAScript 5
                // Internal IsCallable function
                throw new TypeError("Function.prototype.bind - what is trying to be bound is not callable");
            }

            args = Array.prototype.slice.call(arguments, 1);
            fn = this;

            function Empty() {}

            function bound() {
                return fn.apply(this instanceof Empty && object ? this : object,
                    args.concat(Array.prototype.slice.call(arguments)));
            }

            Empty.prototype = this.prototype;
            bound.prototype = new Empty();

            return bound;
        };
    }

    // AMD / RequireJS
    if ("undefined" !== typeof define && define.amd) {
        define([], function() {
            return CircuitBreaker;
        });
    }
    // NodeJS
    else if ("undefined" !== typeof module && module.exports) {
        module.exports = CircuitBreaker;
    }
    // Included directly via <script> tag or inside a WebWorker
    else {
        root.Machineto = CircuitBreaker;
    }
})();
