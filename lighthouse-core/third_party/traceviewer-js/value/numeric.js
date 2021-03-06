/**
Copyright 2016 The Chromium Authors. All rights reserved.
Use of this source code is governed by a BSD-style license that can be
found in the LICENSE file.
**/

require("../base/iteration_helpers.js");
require("../base/range.js");
require("../base/running_statistics.js");
require("../base/sorted_array_utils.js");
require("../base/statistics.js");
require("./unit.js");

'use strict';

global.tr.exportTo('tr.v', function() {
  var Range = tr.b.Range;

  var MAX_DIAGNOSTICS = 16;

  // p-values less than this indicate statistical significance.
  var DEFAULT_ALPHA = 0.05;

  /** @enum */
  var Significance = {
    DONT_CARE: -1,
    INSIGNIFICANT: 0,
    SIGNIFICANT: 1
  };

  function NumericBase(unit) {
    if (!(unit instanceof tr.v.Unit))
      throw new Error('Expected provided unit to be instance of Unit');

    this.unit = unit;
  }

  NumericBase.prototype = {
    merge: function(other) {
      if (this.unit !== other.unit)
        throw new Error('Merging Numerics with different units');

      // Two Numerics that were built using the same NumericBuilder
      // can be merged using addNumeric().
      if (this instanceof Numeric && other instanceof Numeric &&
          this.canAddNumeric(other)) {
        var result = this.clone();
        result.addNumeric(other.clone());
        return result;
      }

      // Either a Scalar and a Numeric, or two Scalars...
      // or two Numerics that were not built using the same NumericBuilder,
      // should be built from their raw samples.
      var samples = [];
      this.sampleValuesInto(samples);
      other.sampleValuesInto(samples);
      return Numeric.buildFromSamples(this.unit, samples);
    },

    sampleValuesInto: function(samples) {
      throw new Error('Not implemented');
    },

    asDict: function() {
      var d = {
        unit: this.unit.asJSON()
      };

      this.asDictInto_(d);
      return d;
    }
  };

  NumericBase.fromDict = function(d) {
    if (d.type === 'scalar')
      return ScalarNumeric.fromDict(d);

    if (d.type === 'numeric')
      return Numeric.fromDict(d);

    throw new Error('Not implemented');
  };

  function NumericBin(parentNumeric, opt_range) {
    this.parentNumeric = parentNumeric;
    this.range = opt_range || (new tr.b.Range());
    this.count = 0;
    this.diagnostics = [];
  }

  NumericBin.fromDict = function(parentNumeric, d) {
    var n = new NumericBin(parentNumeric);
    n.range.min = d.min;
    n.range.max = d.max;
    n.count = d.count;
    if (d.diagnostics)
      n.diagnostics = d.diagnostics.map(dd => tr.v.d.Diagnostic.fromDict(dd));
    return n;
  };

  NumericBin.prototype = {
    /**
     * @param {*} value
     * @param {!tr.v.d.Diagnostic=} opt_diagnostic
     */
    add: function(value, opt_diagnostic) {
      this.count += 1;
      if (opt_diagnostic) {
        tr.b.Statistics.uniformlySampleStream(
            this.diagnostics, this.count, opt_diagnostic, MAX_DIAGNOSTICS);
      }
    },

    addBin: function(other) {
      if (!this.range.equals(other.range))
        throw new Error('Merging incompatible Numeric bins.');
      tr.b.Statistics.mergeSampledStreams(this.diagnostics, this.count,
          other.diagnostics, other.count, MAX_DIAGNOSTICS);
      this.count += other.count;
    },

    asDict: function() {
      return {
        min: this.range.min,
        max: this.range.max,
        count: this.count,
        diagnostics: this.diagnostics.map(d => d.asDict())
      };
    },

    asJSON: function() {
      return this.asDict();
    }
  };

  function Numeric(unit, range, binInfo) {
    NumericBase.call(this, unit);

    this.range = range;

    this.numNans = 0;
    this.nanDiagnostics = [];

    this.running = new tr.b.RunningStatistics();
    this.maxCount_ = 0;

    this.underflowBin = binInfo.underflowBin;
    this.centralBins = binInfo.centralBins;
    this.overflowBin = binInfo.overflowBin;

    this.allBins = [];
    this.allBins.push(this.underflowBin);
    this.allBins.push.apply(this.allBins, this.centralBins);
    this.allBins.push(this.overflowBin);

    this.allBins.forEach(function(bin) {
      if (bin.count > this.maxCount_)
        this.maxCount_ = bin.count;
    }, this);

    this.sampleValues_ = [];
    this.maxNumSampleValues = this.allBins.length * 10;

    this.summaryOptions = this.defaultSummaryOptions();
  }

  Numeric.fromDict = function(d) {
    var range = Range.fromExplicitRange(d.min, d.max);
    var binInfo = {};
    binInfo.underflowBin = NumericBin.fromDict(undefined, d.underflowBin);
    binInfo.centralBins = d.centralBins.map(function(binAsDict) {
      return NumericBin.fromDict(undefined, binAsDict);
    });
    binInfo.overflowBin = NumericBin.fromDict(undefined, d.overflowBin);
    var n = new Numeric(tr.v.Unit.fromJSON(d.unit), range, binInfo);
    n.allBins.forEach(function(bin) {
      bin.parentNumeric = n;
    });
    if (d.running)
      n.running = tr.b.RunningStatistics.fromDict(d.running);
    if (d.summaryOptions)
      n.customizeSummaryOptions(d.summaryOptions);
    n.numNans = d.numNans;
    if (d.nanDiagnostics) {
      n.nanDiagnostics = d.nanDiagnostics.map(
          dd => tr.v.d.Diagnostic.fromDict(dd));
    }
    n.maxNumSampleValues = d.maxNumSampleValues;
    n.sampleValues_ = d.sampleValues;
    return n;
  };

  /**
   * @param {!tr.v.Unit} unit
   * @param {!Array.<number>} samples
   * @return {!Numeric}
   */
  Numeric.buildFromSamples = function(unit, samples) {
    var range = new tr.b.Range();
    // Prevent non-numeric samples from introducing NaNs into the range.
    for (var sample of samples)
      if (!isNaN(Math.max(sample)))
        range.addValue(sample);

    // NumericBuilder.addLinearBins() requires this.
    if (range.isEmpty)
      range.addValue(1);
    if (range.min === range.max)
      range.addValue(range.min - 1);

    // This optimizes the resolution when samples are uniformly distributed
    // (which is almost never the case).
    var numBins = Math.ceil(Math.sqrt(samples.length));
    var builder = new NumericBuilder(unit, range.min);
    builder.addLinearBins(range.max, numBins);

    var result = builder.build();
    result.maxNumSampleValues = 1000;

    // TODO(eakuefner): Propagate diagnostics?
    for (var sample of samples)
      result.add(sample);

    return result;
  };

  Numeric.prototype = {
    __proto__: NumericBase.prototype,

    get numValues() {
      return tr.b.Statistics.sum(this.allBins, function(e) {
        return e.count;
      });
    },

    get average() {
      return this.running.mean;
    },

    get sum() {
      return this.running.sum;
    },

    get maxCount() {
      return this.maxCount_;
    },

    /**
     * Requires that units agree.
     * Returns DONT_CARE if that is the units' improvementDirection.
     * Returns SIGNIFICANT if the Mann-Whitney U test returns a
     * p-value less than opt_alpha or DEFAULT_ALPHA. Returns INSIGNIFICANT if
     * the p-value is greater than alpha.
     *
     * @param {!tr.v.Numeric} other
     * @param {number=} opt_alpha
     * @return {!tr.v.Significance}
     */
    getDifferenceSignificance: function(other, opt_alpha) {
      if (this.unit !== other.unit)
        throw new Error('Cannot compare Numerics with different units');

      if (this.unit.improvementDirection ===
          tr.v.ImprovementDirection.DONT_CARE) {
        return tr.v.Significance.DONT_CARE;
      }

      if (!(other instanceof Numeric))
        throw new Error('Unable to compute a p-value');

      var mwu = tr.b.Statistics.mwu.test(this.sampleValues, other.sampleValues);
      if (mwu.p < (opt_alpha || DEFAULT_ALPHA))
        return tr.v.Significance.SIGNIFICANT;
      return tr.v.Significance.INSIGNIFICANT;
    },

    /*
     * Compute an approximation of percentile based on the counts in the bins.
     * If the real percentile lies within |this.range| then the result of
     * the function will deviate from the real percentile by at most
     * the maximum width of the bin(s) within which the point(s)
     * from which the real percentile would be calculated lie.
     * If the real percentile is outside |this.range| then the function
     * returns the closest range limit: |this.range.min| or |this.range.max|.
     *
     * @param {number} percent The percent must be between 0.0 and 1.0.
     */
    getApproximatePercentile: function(percent) {
      if (!(percent >= 0 && percent <= 1))
        throw new Error('percent must be [0,1]');
      if (this.numValues == 0)
        return 0;
      var valuesToSkip = Math.floor((this.numValues - 1) * percent);
      for (var i = 0; i < this.allBins.length; i++) {
        var bin = this.allBins[i];
        valuesToSkip -= bin.count;
        if (valuesToSkip < 0) {
          if (bin === this.underflowBin)
            return bin.range.max;
          else if (bin === this.overflowBin)
            return bin.range.min;
          else
            return bin.range.center;
        }
      }
      throw new Error('Unreachable');
    },

    getInterpolatedCountAt: function(value) {
      var bin = this.getBinForValue(value);
      var idx = this.centralBins.indexOf(bin);
      if (idx < 0) {
        // |value| is in either the underflowBin or the overflowBin.
        // We can't interpolate between infinities.
        return bin.count;
      }

      // |value| must fall between the centers of two bins.
      // The bin whose center is less than |value| will be this:
      var lesserBin = bin;

      // The bin whose center is greater than |value| will be this:
      var greaterBin = bin;

      // One of those bins could be an under/overflow bin.
      // Avoid dealing with Infinities by arbitrarily saying that center of the
      // underflow bin is its range.max, and the center of the overflow bin is
      // its range.min.
      // The centers of bins in |this.centralBins| will default to their
      // |range.center|.

      var lesserBinCenter = undefined;
      var greaterBinCenter = undefined;

      if (value < greaterBin.range.center) {
        if (idx > 0) {
          lesserBin = this.centralBins[idx - 1];
        } else {
          lesserBin = this.underflowBin;
          lesserBinCenter = lesserBin.range.max;
        }
      } else {
        if (idx < (this.centralBins.length - 1)) {
          greaterBin = this.centralBins[idx + 1];
        } else {
          greaterBin = this.overflowBin;
          greaterBinCenter = greaterBin.range.min;
        }
      }

      if (greaterBinCenter === undefined)
        greaterBinCenter = greaterBin.range.center;

      if (lesserBinCenter === undefined)
        lesserBinCenter = lesserBin.range.center;

      value = tr.b.normalize(value, lesserBinCenter, greaterBinCenter);

      return tr.b.lerp(value, lesserBin.count, greaterBin.count);
    },

    getBinForValue: function(value) {
      // Don't use subtraction to avoid arithmetic overflow.
      var binIndex = tr.b.findHighIndexInSortedArray(
          this.allBins, b => value < b.range.max ? -1 : 1);
      return this.allBins[binIndex] || this.overflowBin;
    },

    /**
     * @param {*} value
     * @param {!tr.v.d.Diagnostic=} opt_diagnostic
     */
    add: function(value, opt_diagnostic) {
      if (typeof(value) !== 'number' || isNaN(value)) {
        this.numNans++;
        if (opt_diagnostic) {
          tr.b.Statistics.uniformlySampleStream(this.nanDiagnostics,
              this.numNans, opt_diagnostic, MAX_DIAGNOSTICS);
        }
      } else {
        var bin = this.getBinForValue(value);
        bin.add(value, opt_diagnostic);
        this.running.add(value);
        if (bin.count > this.maxCount_)
          this.maxCount_ = bin.count;
      }

      tr.b.Statistics.uniformlySampleStream(this.sampleValues_,
          this.numValues + this.numNans, value, this.maxNumSampleValues);
    },

    sampleValuesInto: function(samples) {
      for (var sampleValue of this.sampleValues)
        samples.push(sampleValue);
    },

    /**
     * Return true if this Numeric can be added to |other|.
     *
     * @param {!tr.v.Numeric} other
     * @return {boolean}
     */
    canAddNumeric: function(other) {
      if (!this.range.equals(other.range))
        return false;
      if (this.unit !== other.unit)
        return false;
      if (this.allBins.length !== other.allBins.length)
        return false;

      for (var i = 0; i < this.allBins.length; ++i)
        if (!this.allBins[i].range.equals(other.allBins[i].range))
          return false;

      return true;
    },

    /**
     * Add |other| to this Numeric in-place if they can be added.
     *
     * @param {!tr.v.Numeric} other
     */
    addNumeric: function(other) {
      if (!this.canAddNumeric(other))
        throw new Error('Merging incompatible Numerics.');

      tr.b.Statistics.mergeSampledStreams(this.nanDiagnostics, this.numNans,
          other.nanDiagnostics, other.numNans, MAX_DIAGNOSTICS);
      tr.b.Statistics.mergeSampledStreams(
          this.sampleValues, this.numValues,
          other.sampleValues, other.numValues, tr.b.Statistics.mean(
              [this.maxNumSampleValues, other.maxNumSampleValues]));
      this.numNans += other.numNans;
      this.running = this.running.merge(other.running);
      for (var i = 0; i < this.allBins.length; ++i) {
        this.allBins[i].addBin(other.allBins[i]);
      }
    },

    /**
     * Controls which statistics are exported to dashboard for this numeric.
     * The |summaryOptions| parameter is a dictionary with optional boolean
     * fields |count|, |sum|, |avg|, |std|, |min|, |max| and an optional
     * array field |percentile|.
     * Each percentile should be a number between 0.0 and 1.0.
     * The options not included in the |summaryOptions| will not change.
     */
    customizeSummaryOptions: function(summaryOptions) {
      tr.b.iterItems(summaryOptions, function(key, value) {
        this.summaryOptions[key] = value;
      }, this);
    },

    defaultSummaryOptions: function() {
      return {
        count: true,
        sum: true,
        avg: true,
        std: true,
        min: true,
        max: true,
        nans: false,
        percentile: []
      };
    },

    /**
     * Returns an array of {name: string, scalar: ScalarNumeric} values.
     * Each enabled summary option produces the corresponding value:
     * min, max, count, sum, avg, or std.
     * Each percentile 0.x produces pct_0x0.
     * Each percentile 0.xx produces pct_0xx.
     * Each percentile 0.xxy produces pct_0xx_y.
     * Percentile 1.0 produces pct_100.
     */
    getSummarizedScalarNumericsWithNames: function() {
      function statNameToKey(stat) {
        switch (stat) {
          case 'std':
            return 'stddev';
          case 'avg':
            return 'mean';
        }
        return stat;
      }
      /**
       * Converts the given percent to a string in the format specified above.
       * @param {number} percent The percent must be between 0.0 and 1.0.
       */
      function percentToString(percent) {
        if (percent < 0 || percent > 1)
          throw new Error('Percent must be between 0.0 and 1.0');
        switch (percent) {
          case 0:
            return '000';
          case 1:
            return '100';
        }
        var str = percent.toString();
        if (str[1] !== '.')
          throw new Error('Unexpected percent');
        // Pad short strings with zeros.
        str = str + '0'.repeat(Math.max(4 - str.length, 0));
        if (str.length > 4)
          str = str.slice(0, 4) + '_' + str.slice(4);
        return '0' + str.slice(2);
      }

      var results = [];
      tr.b.iterItems(this.summaryOptions, function(stat, option) {
        if (!option)
          return;
        if (stat === 'percentile') {
          option.forEach(function(percent) {
            var percentile = this.getApproximatePercentile(percent);
            results.push({
                name: 'pct_' + percentToString(percent),
                scalar: new tr.v.ScalarNumeric(this.unit, percentile)
            });
          }, this);
        } else if (stat === 'nans') {
          results.push({
            name: 'nans',
            scalar: new tr.v.ScalarNumeric(
                tr.v.Unit.byName.count_smallerIsBetter, this.numNans)
          });
        } else {
          var statUnit = stat === 'count' ?
              tr.v.Unit.byName.count_smallerIsBetter : this.unit;
          var key = statNameToKey(stat);
          var statValue = this.running[key];
          if (typeof(statValue) === 'number') {
            results.push({
                name: stat,
                scalar: new tr.v.ScalarNumeric(statUnit, statValue)
            });
          }
        }
      }, this);
      return results;
    },

    get sampleValues() {
      return this.sampleValues_;
    },

    clone: function() {
      return Numeric.fromDict(this.asDict());
    },

    asDict: function() {
      var d = {
        unit: this.unit.asJSON(),
        type: 'numeric',

        min: this.range.min,
        max: this.range.max,

        numNans: this.numNans,
        nanDiagnostics: this.nanDiagnostics.map(d => d.asDict()),

        running: this.running.asDict(),
        summaryOptions: this.summaryOptions,

        sampleValues: this.sampleValues,
        maxNumSampleValues: this.maxNumSampleValues,
        underflowBin: this.underflowBin.asDict(),
        centralBins: this.centralBins.map(function(bin) {
          return bin.asDict();
        }),
        overflowBin: this.overflowBin.asDict()
      };
      return d;
    },

    asJSON: function() {
      return this.asDict();
    }
  };

  /**
   * Reusable builder for tr.v.Numeric objects.
   *
   * The bins of the numeric are specified by adding the desired boundaries
   * between bins. Initially, the builder has only a single boundary:
   *
   *       minBinBoundary=maxBinBoundary
   *                     |
   *                     |
   *   -MAX_INT <--------|------------------------------------------> +MAX_INT
   *       :  resulting  :                   resulting                    :
   *       :  underflow  :                    overflow                    :
   *       :     bin     :                      bin                       :
   *
   * More boundaries can be added (in increasing order) using addBinBoundary,
   * addLinearBins and addExponentialBins:
   *
   *              minBinBoundary                      maxBinBoundary
   *                     |         |         |     |         |
   *                     |         |         |     |         |
   *   -MAX_INT <--------|---------|---------|-----|---------|------> +MAX_INT
   *       :  resulting  : result. : result. :     : result. : resulting  :
   *       :  underflow  : central : central : ... : central :  overflow  :
   *       :     bin     :  bin 0  :  bin 1  :     : bin N-1 :    bin     :
   *
   * An important feature of the builder is that it's reusable, i.e. it can be
   * used to build multiple numerics with the same unit and bin structure.
   *
   * @constructor
   * @param {!tr.v.Unit} unit Unit of the resulting Numeric(s).
   * @param {number} minBinBoundary The minimum boundary between bins, namely
   *     the underflow bin and the first central bin (or the overflow bin if
   *     no other boundaries are added later).
   */
  function NumericBuilder(unit, minBinBoundary) {
    this.unit_ = unit;
    this.boundaries_ = [minBinBoundary];
  }

  NumericBuilder.prototype = {
    get minBinBoundary() {
      return this.boundaries_[0];
    },

    get maxBinBoundary() {
      return this.boundaries_[this.boundaries_.length - 1];
    },

    /**
     * Add a bin boundary |nextMaxBinBoundary| to the builder.
     *
     * This operation effectively corresponds to appending a new central bin
     * with the range [this.maxBinBoundary*, nextMaxBinBoundary].
     *
     * @param {number} nextMaxBinBoundary The added bin boundary (must be
     *     greater than |this.maxMinBoundary|).
     */
    addBinBoundary: function(nextMaxBinBoundary) {
      if (nextMaxBinBoundary <= this.maxBinBoundary) {
        throw new Error('The added max bin boundary must be larger than ' +
            'the current max boundary');
      }
      this.boundaries_.push(nextMaxBinBoundary);

      return this;
    },

    /**
     * Add |binCount| linearly scaled bin boundaries up to |nextMaxBinBoundary|
     * to the builder.
     *
     * This operation corresponds to appending |binCount| central bins of
     * constant range width
     * W = ((|nextMaxBinBoundary| - |this.maxBinBoundary|) / |binCount|)
     * with the following ranges:
     *
     *   [|this.maxMinBoundary|, |this.maxMinBoundary| + W]
     *   [|this.maxMinBoundary| + W, |this.maxMinBoundary| + 2W]
     *   [|this.maxMinBoundary| + 2W, |this.maxMinBoundary| + 3W]
     *   ...
     *   [|this.maxMinBoundary| + (|binCount| - 2) * W,
     *    |this.maxMinBoundary| + (|binCount| - 2) * W]
     *   [|this.maxMinBoundary| + (|binCount| - 1) * W,
     *    |nextMaxBinBoundary|]
     *
     * @param {number} nextBinBoundary The last added bin boundary (must be
     *     greater than |this.maxMinBoundary|).
     * @param {number} binCount Number of bins to be added (must be positive).
     */
    addLinearBins: function(nextMaxBinBoundary, binCount) {
      if (binCount <= 0)
        throw new Error('Bin count must be positive');

      var curMaxBinBoundary = this.maxBinBoundary;
      if (curMaxBinBoundary >= nextMaxBinBoundary) {
        throw new Error('The new max bin boundary must be greater than ' +
            'the previous max bin boundary');
      }

      var binWidth = (nextMaxBinBoundary - curMaxBinBoundary) / binCount;
      for (var i = 1; i < binCount; i++)
        this.addBinBoundary(curMaxBinBoundary + i * binWidth);
      this.addBinBoundary(nextMaxBinBoundary);

      return this;
    },

    /**
     * Add |binCount| exponentially scaled bin boundaries up to
     * |nextMaxBinBoundary| to the builder.
     *
     * This operation corresponds to appending |binCount| central bins with
     * a constant difference between the logarithms of their range min and max
     * D = ((ln(|nextMaxBinBoundary|) - ln(|this.maxBinBoundary|)) / |binCount|)
     * with the following ranges:
     *
     *   [|this.maxMinBoundary|, |this.maxMinBoundary| * exp(D)]
     *   [|this.maxMinBoundary| * exp(D), |this.maxMinBoundary| * exp(2D)]
     *   [|this.maxMinBoundary| * exp(2D), |this.maxMinBoundary| * exp(3D)]
     *   ...
     *   [|this.maxMinBoundary| * exp((|binCount| - 2) * D),
     *    |this.maxMinBoundary| * exp((|binCount| - 2) * D)]
     *   [|this.maxMinBoundary| * exp((|binCount| - 1) * D),
     *    |nextMaxBinBoundary|]
     *
     * This method requires that the current max bin boundary is positive.
     *
     * @param {number} nextBinBoundary The last added bin boundary (must be
     *     greater than |this.maxMinBoundary|).
     * @param {number} binCount Number of bins to be added (must be positive).
     */
    addExponentialBins: function(nextMaxBinBoundary, binCount) {
      if (binCount <= 0)
        throw new Error('Bin count must be positive');

      var curMaxBinBoundary = this.maxBinBoundary;
      if (curMaxBinBoundary <= 0)
        throw new Error('Current max bin boundary must be positive');
      if (curMaxBinBoundary >= nextMaxBinBoundary) {
        throw new Error('The last added max boundary must be greater than ' +
            'the current max boundary boundary');
      }

      var binExponentWidth =
          Math.log(nextMaxBinBoundary / curMaxBinBoundary) / binCount;
      for (var i = 1; i < binCount; i++) {
        this.addBinBoundary(
            curMaxBinBoundary * Math.exp(i * binExponentWidth));
      }
      this.addBinBoundary(nextMaxBinBoundary);

      return this;
    },

    /**
     * Build a tr.v.Numeric from the list of bin boundaries.
     *
     * As explained earlier, this method can be called arbitrarily many times
     * to produce arbitrarily many distinct numerics.
     */
    build: function() {
      var binInfo = {
        underflowBin: new NumericBin(undefined,
            Range.fromExplicitRange(-Number.MAX_VALUE, this.minBinBoundary)),
        overflowBin: new NumericBin(undefined,
            Range.fromExplicitRange(this.maxBinBoundary, Number.MAX_VALUE)),
        centralBins: new Array(this.boundaries_.length - 1)
      };
      for (var i = 0; i < this.boundaries_.length - 1; i++) {
        binInfo.centralBins[i] = new NumericBin(undefined,
            Range.fromExplicitRange(
                this.boundaries_[i], this.boundaries_[i + 1]));
      }

      var numeric = new Numeric(
          this.unit_,
          Range.fromExplicitRange(this.minBinBoundary, this.maxBinBoundary),
          binInfo);
      numeric.allBins.forEach(function(bin) {
        bin.parentNumeric = numeric;
      });
      return numeric;
    }
  };

  /**
   * Create a linearly scaled tr.v.NumericBuilder with |numBins| bins ranging
   * from |range.min| to |range.max|.
   *
   * @param {!tr.v.Unit} unit
   * @param {!tr.b.Range} range
   * @param {number} numBins
   * @return {tr.v.NumericBuilder}
   */
  NumericBuilder.createLinear = function(unit, range, numBins) {
    if (range.isEmpty)
      throw new Error('Range must be non-empty');
    return new NumericBuilder(unit, range.min).addLinearBins(
        range.max, numBins);
  };

  /**
   * Create an exponentially scaled tr.v.NumericBuilder with |numBins| bins
   * ranging from |range.min| to |range.max|.
   *
   * @param {!tr.v.Unit} unit
   * @param {!tr.b.Range} range
   * @param {number} numBins
   * @return {tr.v.NumericBuilder}
   */
  NumericBuilder.createExponential = function(unit, range, numBins) {
    if (range.isEmpty)
      throw new Error('Range must be non-empty');
    return new NumericBuilder(unit, range.min).addExponentialBins(
        range.max, numBins);
  };

  function ScalarNumeric(unit, value) {
    if (!(unit instanceof tr.v.Unit))
      throw new Error('Expected Unit');

    if (!(typeof(value) == 'number'))
      throw new Error('Expected value to be number');

    NumericBase.call(this, unit);
    this.value = value;
  }

  ScalarNumeric.prototype = {
    __proto__: NumericBase.prototype,

    asDictInto_: function(d) {
      d.type = 'scalar';

      // Infinity and NaN are left out of JSON for security reasons that do not
      // apply to our use cases.
      if (this.value === Infinity)
        d.value = 'Infinity';
      else if (this.value === -Infinity)
        d.value = '-Infinity';
      else if (isNaN(this.value))
        d.value = 'NaN';
      else
        d.value = this.value;
    },

    sampleValuesInto: function(samples) {
      samples.push(this.value);
    },

    toString: function() {
      return this.unit.format(this.value);
    }
  };

  ScalarNumeric.fromDict = function(d) {
    // Infinity and NaN are left out of JSON for security reasons that do not
    // apply to our use cases.
    if (typeof(d.value) === 'string') {
      if (d.value === '-Infinity') {
        d.value = -Infinity;
      } else if (d.value === 'Infinity') {
        d.value = Infinity;
      } else if (d.value === 'NaN') {
        d.value = NaN;
      }
    }

    return new ScalarNumeric(tr.v.Unit.fromJSON(d.unit), d.value);
  };

  return {
    Significance: Significance,
    NumericBase: NumericBase,
    NumericBin: NumericBin,
    Numeric: Numeric,
    NumericBuilder: NumericBuilder,
    ScalarNumeric: ScalarNumeric
  };
});
