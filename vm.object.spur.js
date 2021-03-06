"use strict";
/*
 * Copyright (c) 2013-2019 Bert Freudenberg
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 */

Squeak.Object.subclass('Squeak.ObjectSpur',
'initialization',
{
    initInstanceOf: function(aClass, indexableSize, hash, nilObj) {
        this.sqClass = aClass;
        this.hash = hash;
        var instSpec = aClass.pointers[Squeak.Class_format],
            instSize = instSpec & 0xFFFF,
            format = (instSpec>>16) & 0x1F
        this._format = format;
        if (format < 12) {
            if (format < 10) {
                if (instSize + indexableSize > 0)
                    this.pointers = this.fillArray(instSize + indexableSize, nilObj);
            } else // Words
                if (indexableSize > 0)
                    if (aClass.isFloatClass) {
                        this.isFloat = true;
                        this.float = 0.0;
                    } else
                        this.words = new Uint32Array(indexableSize);
        } else // Bytes
            if (indexableSize > 0) {
                // this._format |= -indexableSize & 3;       //deferred to writeTo()
                this.bytes = new Uint8Array(indexableSize);  //Methods require further init of pointers
            }
//      Definition of Spur's format code...
//
//     0 = 0 sized objects (UndefinedObject True False et al)
//     1 = non-indexable objects with inst vars (Point et al)
//     2 = indexable objects with no inst vars (Array et al)
//     3 = indexable objects with inst vars (MethodContext AdditionalMethodState et al)
//     4 = weak indexable objects with inst vars (WeakArray et al)
//     5 = weak non-indexable objects with inst vars (ephemerons) (Ephemeron)
//     6 = unused
//     7 = immediates (SmallInteger, Character)
//     8 = unused
//     9 = 64-bit indexable
// 10-11 = 32-bit indexable (Bitmap)          (plus one odd bit, unused in 32-bits)
// 12-15 = 16-bit indexable                   (plus two odd bits, one unused in 32-bits)
// 16-23 = 8-bit indexable                    (plus three odd bits, one unused in 32-bits)
// 24-31 = compiled methods (CompiledMethod)  (plus three odd bits, one unused in 32-bits)
    },
    installFromImage: function(oopMap, rawBits, classTable, floatClass, littleEndian, getCharacter) {
        //Install this object by decoding format, and rectifying pointers
        var classID = this.sqClass;
        if (classID < 32) throw Error("Invalid class ID: " + classID);
        this.sqClass = classTable[classID];
        if (!this.sqClass) throw Error("Class ID not in class table: " + classID);
        var bits = rawBits[this.oop],
            nWords = bits.length;
        switch (this._format) {
            case 0: // zero sized object
              // Pharo bug: Pharo 6.0 still has format 0 objects that actually do have inst vars
              // https://pharo.fogbugz.com/f/cases/19010/ImmediateLayout-and-EphemeronLayout-have-wrong-object-format
              // so we pretend these are regular objects and rely on nWords
            case 1: // only inst vars
            case 2: // only indexed vars
            case 3: // inst vars and indexed vars
            case 4: // only indexed vars (weak)
            case 5: // only inst vars (weak)
                if (nWords > 0) {
                    var oops = bits; // endian conversion was already done
                    this.pointers = this.decodePointers(nWords, oops, oopMap, getCharacter);
                }
                break;
            case 10: // 32 bit array
                if (this.sqClass === floatClass) {
                    //These words are actually a Float
                    this.isFloat = true;
                    this.float = this.decodeFloat(bits, littleEndian, true);
                    if (this.float == 1.3797216632888e-310) {
                        if (Squeak.noFloatDecodeWorkaround) {
                            // floatDecode workaround disabled
                        } else {
                            this.constructor.prototype.decodeFloat = this.decodeFloatDeoptimized;
                            this.float = this.decodeFloat(bits, littleEndian, true);
                            if (this.float == 1.3797216632888e-310)
                                throw Error("Cannot deoptimize decodeFloat");
                        }
                    }
                } else if (nWords > 0) {
                    this.words = this.decodeWords(nWords, bits, littleEndian);
                }
                break
            case 12: // 16 bit array
            case 13: // 16 bit array (odd length)
                throw Error("16 bit arrays not supported yet");
            case 16: // 8 bit array
            case 17: // ... length-1
            case 18: // ... length-2
            case 19: // ... length-3
                if (nWords > 0)
                    this.bytes = this.decodeBytes(nWords, bits, 0, this._format & 3);
                break;
            case 24: // CompiledMethod
            case 25: // CompiledMethod
            case 26: // CompiledMethod
            case 27: // CompiledMethod
                var rawHeader = this.decodeWords(1, bits, littleEndian)[0];
                if (rawHeader & 0x80000000) throw Error("Alternate bytecode set not supported")
                var numLits = (rawHeader >> 1) & 0x7FFF,
                    oops = this.decodeWords(numLits+1, bits, littleEndian);
                this.pointers = this.decodePointers(numLits+1, oops, oopMap, getCharacter); //header+lits
                this.bytes = this.decodeBytes(nWords-(numLits+1), bits, numLits+1, this._format & 3);
                break
            default:
                throw Error("Unknown object format: " + this._format);

        }
        this.mark = false; // for GC
    },
    decodePointers: function(nWords, theBits, oopMap, getCharacter) {
        //Convert immediate objects and look up object pointers in oopMap
        var ptrs = new Array(nWords);
        for (var i = 0; i < nWords; i++) {
            var oop = theBits[i];
            if ((oop & 1) === 1) {          // SmallInteger
                ptrs[i] = oop >> 1;
            } else if ((oop & 3) === 2) {   // Character
                ptrs[i] = getCharacter(oop >>> 2);
            } else {                        // Object
                ptrs[i] = oopMap[oop] || 42424242;
                // when loading a context from image segment, there is
                // garbage beyond its stack pointer, resulting in the oop
                // not being found in oopMap. We just fill in an arbitrary
                // SmallInteger - it's never accessed anyway
            }
        }
        return ptrs;
    },
    initInstanceOfChar: function(charClass, unicode) {
        this.oop = (unicode << 2) | 2;
        this.sqClass = charClass;
        this.hash = unicode;
        this._format = 7;
        this.mark = true;   // stays always marked so not traced by GC
    },
    classNameFromImage: function(oopMap, rawBits) {
        var name = oopMap[rawBits[this.oop][Squeak.Class_name]];
        if (name && name._format >= 16 && name._format < 24) {
            var bits = rawBits[name.oop],
                bytes = name.decodeBytes(bits.length, bits, 0, name._format & 7);
            return Squeak.bytesAsString(bytes);
        }
        return "Class";
    },
    renameFromImage: function(oopMap, rawBits, classTable) {
        var classObj = classTable[this.sqClass];
        if (!classObj) return this;
        var instProto = classObj.instProto || classObj.classInstProto(classObj.classNameFromImage(oopMap, rawBits));
        if (!instProto) return this;
        var renamedObj = new instProto; // Squeak.SpurObject
        renamedObj.oop = this.oop;
        renamedObj.sqClass = this.sqClass;
        renamedObj._format = this._format;
        renamedObj.hash = this.hash;
        return renamedObj;
    },
},
'accessing', {
    instSize: function() {//same as class.classInstSize, but faster from format
        if (this._format < 2) return this.pointersSize(); //fixed fields only
        return this.sqClass.classInstSize();
    },
    indexableSize: function(primHandler) {
        var fmt = this._format;
        if (fmt < 2) return -1; //not indexable
        if (fmt === 3 && primHandler.vm.isContext(this))
            return this.pointers[Squeak.Context_stackPointer]; // no access beyond top of stacks
        if (fmt < 6) return this.pointersSize() - this.instSize(); // pointers
        if (fmt < 12) return this.wordsSize(); // words
        if (fmt < 16) return this.shortsSize(); // shorts
        if (fmt < 24) return this.bytesSize(); // bytes
        return 4 * this.pointersSize() + this.bytesSize(); // methods
    },
    snapshotSize: function() {
        // words of extra object header and body this object would take up in image snapshot
        // body size includes header size that is always present
        var nWords =
            this.isFloat ? 2 :
            this.words ? this.words.length :
            this.pointers ? this.pointers.length : 0;
        // methods have both pointers and bytes
        if (this.bytes) nWords += (this.bytes.length + 3) >>> 2;
        var extraHeader = nWords >= 255 ? 2 : 0;
        nWords += nWords & 1; // align to 8 bytes
        nWords += 2; // one 64 bit header always present
        if (nWords < 4) nWords = 4; // minimum object size
        return {header: extraHeader, body: nWords};
    },
    writeTo: function(data, pos, littleEndian, objToOop) {
        var nWords =
            this.isFloat ? 2 :
            this.words ? this.words.length :
            this.pointers ? this.pointers.length : 0;
        if (this.bytes) {
            nWords += (this.bytes.length + 3) >>> 2;
            this._format |= -this.bytes.length & 3;
        }
        var beforePos = pos,
            formatAndClass = (this._format << 24) | (this.sqClass.hash & 0x003FFFFF),
            sizeAndHash = (nWords << 24) | (this.hash & 0x003FFFFF);
        // write extra header if needed
        if (nWords >= 255) {
            data.setUint32(pos, nWords, littleEndian); pos += 4;
            sizeAndHash = (255 << 24) | (this.hash & 0x003FFFFF);
            data.setUint32(pos, sizeAndHash, littleEndian); pos += 4;
        }
        // write regular header
        data.setUint32(pos, formatAndClass, littleEndian); pos += 4;
        data.setUint32(pos, sizeAndHash, littleEndian); pos += 4;
        // now write body, if any
        if (this.isFloat) {
            data.setFloat64(pos, this.float, littleEndian); pos += 8;
        } else if (this.words) {
            for (var i = 0; i < this.words.length; i++) {
                data.setUint32(pos, this.words[i], littleEndian); pos += 4;
            }
        } else if (this.pointers) {
            for (var i = 0; i < this.pointers.length; i++) {
                data.setUint32(pos, objToOop(this.pointers[i]), littleEndian); pos += 4;
            }
        }
        // no "else" because CompiledMethods have both pointers and bytes
        if (this.bytes) {
            for (var i = 0; i < this.bytes.length; i++)
                data.setUint8(pos++, this.bytes[i]);
            // skip to next word
            pos += -this.bytes.length & 3;
        }
        // minimum object size is 16, align to 8 bytes
        if (nWords === 0) pos += 8;
        else pos += (nWords & 1) * 4;
        // done
        if (pos !== beforePos + this.totalBytes()) throw Error("written size does not match");
        return pos;
    },
},
'testing', {
    isBytes: function() {
        var fmt = this._format;
        return fmt >= 16 && fmt <= 23;
    },
    isPointers: function() {
        return this._format <= 6;
    },
    isWords: function() {
        return this._format === 10;
    },
    isWordsOrBytes: function() {
        var fmt = this._format;
        return fmt === 10 || (fmt >= 16 && fmt <= 23);
    },
    isWeak: function() {
        return this._format === 4;
    },
    isMethod: function() {
        return this._format >= 24;
    },
    sameFormats: function(a, b) {
        return a < 16 ? a === b : (a & 0xF8) === (b & 0xF8);
    },
},
'as class', {
    defaultInst: function() {
        return Squeak.ObjectSpur;
    },
    classInstFormat: function() {
        return (this.pointers[Squeak.Class_format] >> 16) & 0x1F;
    },
    classInstSize: function() {
        // this is a class, answer number of named inst vars
        return this.pointers[Squeak.Class_format] & 0xFFFF;
    },
    classByteSizeOfInstance: function(nElements) {
        var format = this.classInstFormat(),
            nWords = this.classInstSize();
        if (format < 9) nWords += nElements;                        // 32 bit
        else if (format >= 16) nWords += (nElements + 3) / 4 | 0;   //  8 bit
        else if (format >= 12) nWords += (nElements + 1) / 2 | 0;   // 16 bit
        else if (format >= 10) nWords += nElements;                 // 32 bit
        else nWords += nElements * 2;                               // 64 bit
        nWords += nWords & 1;                                       // align to 64 bits
        nWords += nWords >= 255 ? 4 : 2;                            // header words
        if (nWords < 4) nWords = 4;                                 // minimum object size
        return nWords * 4;
    },
},
'as method', {
    methodNumLits: function() {
        return this.pointers[0] & 0x7FFF;
    },
    methodPrimitiveIndex: function() {
        if ((this.pointers[0] & 0x10000) === 0) return 0;
        return this.bytes[1] + 256 * this.bytes[2];
    },
});
