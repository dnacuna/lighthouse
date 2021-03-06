/**
Copyright 2016 The Chromium Authors. All rights reserved.
Use of this source code is governed by a BSD-style license that can be
found in the LICENSE file.
**/

require("../../base/extension_registry.js");

'use strict';

global.tr.exportTo('tr.v.d', function() {
  /** @constructor */
  function Diagnostic() {
  }

  Diagnostic.prototype = {
    asDict: function() {
      var result = {type: this.constructor.name};
      this.asDictInto_(result);
      return result;
    },

    asDictInto_: function(d) {
      throw new Error('Abstract virtual method');
    }
  };

  var options = new tr.b.ExtensionRegistryOptions(tr.b.BASIC_REGISTRY_MODE);
  options.defaultMetadata = {};
  options.mandatoryBaseClass = Diagnostic;
  tr.b.decorateExtensionRegistry(Diagnostic, options);

  Diagnostic.addEventListener('will-register', function(e) {
    var constructor = e.typeInfo.constructor;
    if (!(constructor.fromDict instanceof Function) ||
        (constructor.fromDict.length !== 1)) {
      throw new Error('Diagnostics must define fromDict(d)');
    }

    // When subclasses set their prototype to an entirely new object and omit
    // their constructor, then it becomes impossible for asDict() to find their
    // constructor name. Add it back here so that asDict() can find it.
    constructor.prototype.constructor = constructor;
  });

  Diagnostic.fromDict = function(d) {
    var typeInfo = Diagnostic.findTypeInfoWithName(d.type);
    if (!typeInfo)
      throw new Error('Unrecognized diagnostic type: ' + d.type);

    return typeInfo.constructor.fromDict(d);
  };

  return {
    Diagnostic: Diagnostic
  };
});
